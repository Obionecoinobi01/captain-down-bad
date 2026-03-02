// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CaptainDownBad} from "../src/CaptainDownBad.sol";
import {CaptainDownBadHarness} from "./CaptainDownBadHarness.sol";

// ---------------------------------------------------------------------------
// Minimal ERC-20 mock — etched over the hardcoded USDC address in setUp
// ---------------------------------------------------------------------------
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from]             -= amt;
        balanceOf[to]               += amt;
        return true;
    }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
contract CaptainDownBadTest is Test {

    // ---- Constants mirrored from contract ----
    address constant USDC_ADDR = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant LEVEL_W   = 32;
    uint256 constant LEVEL_H   = 16;
    uint256 constant BET       = 5e6;   // 5 USDC (6 decimals)
    bytes32 constant SALT      = bytes32("captain_salt");

    // ---- Bit shifts (mirror contract private constants) ----
    uint256 constant POS_X_SHIFT  = 248;
    uint256 constant POS_Y_SHIFT  = 240;
    uint256 constant VEL_Y_SHIFT  = 232;
    uint256 constant HEALTH_SHIFT = 224;
    uint256 constant ANIM_SHIFT   = 216;
    uint256 constant SCORE_MASK   = type(uint56).max;

    // ---- Test actors ----
    address constant OWNER   = address(0xA11CE);
    address constant PLAYER  = address(0xB0B);
    address constant PLAYER2 = address(0xC4C);
    address constant RANDO   = address(0xDEAD);

    CaptainDownBadHarness game;  // harness IS-A CaptainDownBad; all existing tests unaffected
    MockERC20             usdc;

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    function setUp() public {
        // Etch mock ERC20 at the hardcoded USDC address
        MockERC20 impl = new MockERC20();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockERC20(USDC_ADDR);

        vm.prank(OWNER);
        game = new CaptainDownBadHarness(OWNER, USDC_ADDR);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// @dev Re-implements packed state layout for test assertions.
    function _unpack(uint256 s) internal pure returns (
        uint8 posX, uint8 posY, int8 velY, uint8 health, uint8 animFrame, uint56 score
    ) {
        posX      = uint8(s >> POS_X_SHIFT);
        posY      = uint8(s >> POS_Y_SHIFT);
        velY      = int8(uint8(s >> VEL_Y_SHIFT));
        health    = uint8(s >> HEALTH_SHIFT);
        animFrame = uint8(s >> ANIM_SHIFT);
        score     = uint56(s & SCORE_MASK);
    }

    function _pack(
        uint8 posX, uint8 posY, int8 velY, uint8 health, uint8 animFrame, uint56 score
    ) internal pure returns (uint256) {
        return (uint256(posX)        << POS_X_SHIFT)
             | (uint256(posY)        << POS_Y_SHIFT)
             | (uint256(uint8(velY)) << VEL_Y_SHIFT)
             | (uint256(health)      << HEALTH_SHIFT)
             | (uint256(animFrame)   << ANIM_SHIFT)
             | uint256(score);
    }

    /// @dev Level = all air, with one custom tile.
    function _buildLevel(uint8 tileX, uint8 tileY, uint8 tileVal)
        internal pure returns (bytes memory tiles)
    {
        tiles = new bytes(LEVEL_W * LEVEL_H);
        tiles[uint256(tileY) * LEVEL_W + uint256(tileX)] = bytes1(tileVal);
    }

    /// @dev Level = solid ground row at y=15, plus one custom tile.
    function _buildLevelWithGround(uint8 tileX, uint8 tileY, uint8 tileVal)
        internal pure returns (bytes memory tiles)
    {
        tiles = new bytes(LEVEL_W * LEVEL_H);
        for (uint256 x; x < LEVEL_W; x++) tiles[15 * LEVEL_W + x] = bytes1(uint8(1)); // WALL
        tiles[uint256(tileY) * LEVEL_W + uint256(tileX)] = bytes1(tileVal);
    }

    /// @dev Mint, approve, startRun; returns runId.
    function _startRun(address player, uint256 bet, uint256 levelId)
        internal returns (uint256 runId)
    {
        usdc.mint(player, bet);
        vm.prank(player);
        usdc.approve(address(game), bet);
        vm.prank(player);
        game.startRun(bet, levelId);
        runId = game.nextRunId() - 1;
    }

    /// @dev Full commit → reveal in one call.
    function _tick(uint256 runId, CaptainDownBad.Move move, bytes32 salt, address player)
        internal
    {
        bytes32 hash = keccak256(abi.encodePacked(move, salt, player));
        vm.prank(player);
        game.commitMove(runId, hash);
        vm.prank(player);
        game.revealAndAdvance(runId, move, salt);
    }

    /// @dev Per-tick salt from a seed and index.
    function _salt(uint256 seed, uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(seed, i));
    }

    /// @dev Read run fields without destructuring all 9 every time.
    function _playerState(uint256 runId) internal view returns (uint256) {
        (,,,,,, uint256 ps,,) = game.runs(runId);
        return ps;
    }

    function _isActive(uint256 runId) internal view returns (bool) {
        (,,,,,,, bool a,) = game.runs(runId);
        return a;
    }

    // =========================================================================
    // startRun
    // =========================================================================

    function test_startRun_happyPath() public {
        // Prepare USDC separately so expectEmit fires on the startRun call itself
        usdc.mint(PLAYER, BET);
        vm.prank(PLAYER);
        usdc.approve(address(game), BET);

        vm.expectEmit(true, true, false, true);
        emit CaptainDownBad.RunStarted(0, PLAYER, BET, 0);

        vm.prank(PLAYER);
        game.startRun(BET, 0);

        assertEq(game.nextRunId() - 1, 0);
        assertEq(usdc.balanceOf(address(game)), BET);
        assertTrue(_isActive(0));
    }

    function test_startRun_initialState() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        (uint8 posX, uint8 posY, int8 velY, uint8 health, uint8 animFrame, uint56 score)
            = _unpack(_playerState(runId));

        assertEq(posX,      2,  "posX");
        assertEq(posY,      14, "posY");
        assertEq(velY,      0,  "velY");
        assertEq(health,    3,  "health (INITIAL_HEALTH)");
        assertEq(animFrame, 0,  "animFrame");
        assertEq(score,     0,  "score");
    }

    function test_startRun_zeroBet_reverts() public {
        usdc.mint(PLAYER, 1e6);
        vm.prank(PLAYER);
        usdc.approve(address(game), 1e6);
        vm.prank(PLAYER);
        vm.expectRevert("CDB: bet=0");
        game.startRun(0, 0);
    }

    function test_startRun_levelNotSet_reverts() public {
        usdc.mint(PLAYER, BET);
        vm.prank(PLAYER);
        usdc.approve(address(game), BET);
        vm.prank(PLAYER);
        vm.expectRevert("CDB: level not set");
        game.startRun(BET, 99); // level 99 never seeded
    }

    function test_startRun_incrementsRunId() public {
        _startRun(PLAYER, BET, 0);
        _startRun(PLAYER2, BET, 0);
        assertEq(game.nextRunId(), 2);
    }

    // =========================================================================
    // commitMove
    // =========================================================================

    function test_commitMove_happyPath() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.expectEmit(true, false, false, true);
        emit CaptainDownBad.MoveCommitted(runId, 0, hash);

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        (,,,,, bytes32 stored,,, ) = game.runs(runId);
        assertEq(stored, hash);
    }

    function test_commitMove_notOwner_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        vm.prank(RANDO);
        vm.expectRevert("CDB: not your run");
        game.commitMove(runId, bytes32("x"));
    }

    function test_commitMove_alreadyCommitted_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.prank(PLAYER);
        vm.expectRevert("CDB: already committed");
        game.commitMove(runId, hash);
    }

    function test_commitMove_inactiveRun_reverts() public {
        _startRun(PLAYER, BET, 0); // settle the nextRunId counter

        // Kill the player: put spike at fall destination (2,15) — no ground
        bytes memory tiles = _buildLevel(2, 15, 3); // TILE_SPIKE at fall pos
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        // Start fresh run on deadly level
        uint256 deadRunId = _startRun(PLAYER, BET, 1);

        // Three ticks to deplete health=3
        for (uint256 i; i < 3; i++) {
            _tick(deadRunId, CaptainDownBad.Move.Idle, _salt(1, i), PLAYER);
        }

        assertFalse(_isActive(deadRunId));

        vm.prank(PLAYER);
        vm.expectRevert("CDB: inactive");
        game.commitMove(deadRunId, bytes32("x"));
    }

    // =========================================================================
    // revealAndAdvance
    // =========================================================================

    function test_revealAndAdvance_happyPath() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.expectEmit(true, false, false, false);
        emit CaptainDownBad.MoveRevealed(runId, 0, CaptainDownBad.Move.Idle);

        vm.prank(PLAYER);
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);

        (,,, uint256 tick,, bytes32 commit,,, ) = game.runs(runId);
        assertEq(tick,   1,          "tick advanced");
        assertEq(commit, bytes32(0), "commit cleared");
    }

    function test_revealAndAdvance_hashMismatch_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.prank(PLAYER);
        vm.expectRevert("CDB: commit mismatch");
        game.revealAndAdvance(runId, CaptainDownBad.Move.Jump, SALT); // wrong move
    }

    function test_revealAndAdvance_wrongSalt_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.prank(PLAYER);
        vm.expectRevert("CDB: commit mismatch");
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, bytes32("wrong_salt"));
    }

    function test_revealAndAdvance_expired_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        // Warp past reveal window (TICK_DURATION * REVEAL_WINDOW = 120s)
        vm.warp(block.timestamp + 121);

        vm.prank(PLAYER);
        vm.expectRevert("CDB: reveal expired");
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);
    }

    // =========================================================================
    // advanceExpired
    // =========================================================================

    function test_advanceExpired_happyPath() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.warp(block.timestamp + 121);
        game.advanceExpired(runId); // anyone can call

        (,,, uint256 tick,, bytes32 commit,,, ) = game.runs(runId);
        assertEq(tick,   1,          "tick advanced by expired handler");
        assertEq(commit, bytes32(0), "commit cleared");
    }

    function test_advanceExpired_windowStillOpen_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));

        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.expectRevert("CDB: window still open");
        game.advanceExpired(runId);
    }

    function test_advanceExpired_noCommit_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        vm.expectRevert("CDB: no pending commit");
        game.advanceExpired(runId);
    }

    // =========================================================================
    // Gravity & landing (anti-tunnelling)
    // =========================================================================

    function test_gravity_onGround_staysAtY14() public {
        // Default level: ground at y=15. Player spawns at y=14.
        // Each Idle tick: gravity makes velY=-1, nextY=15 (wall) → revert to y=14.
        uint256 runId = _startRun(PLAYER, BET, 0);

        _tick(runId, CaptainDownBad.Move.Idle, SALT, PLAYER);

        (, uint8 posY, int8 velY,,,) = _unpack(_playerState(runId));
        assertEq(posY, 14, "should land back on y=14 above ground");
        assertEq(velY, 0,  "velY reset on wall hit");
    }

    function test_antiTunneling_wallRevertsPosition() public {
        // Verify posY is reverted to prevPosY (not the wall tile's y)
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Idle, SALT, PLAYER);

        (uint8 px, uint8 py, int8 vy,,,) = _unpack(_playerState(runId));
        assertEq(px, 2,  "posX unchanged");
        assertEq(py, 14, "posY reverted, not tunnelled into wall");
        assertEq(vy, 0,  "velY zeroed on landing");
    }

    function test_jump_setsImpulse() public {
        // Ground + jump: velY becomes JUMP_IMPULSE - 1 after gravity in same tick
        uint256 runId = _startRun(PLAYER, BET, 0);

        // Settle on ground first
        _tick(runId, CaptainDownBad.Move.Idle, SALT, PLAYER);

        // Now jump
        bytes32 s2 = _salt(0, 1);
        _tick(runId, CaptainDownBad.Move.Jump, s2, PLAYER);

        (, uint8 posY, int8 velY,,,) = _unpack(_playerState(runId));
        // After jump: velY=4 set, then gravity -1 → velY=3. nextY=14-3=11. No wall at 11.
        assertEq(velY, 3,  "velY after jump impulse + gravity");
        assertEq(posY, 11, "posY moved up from 14");
    }

    function test_jump_cannotDoubleJump() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Idle, SALT, PLAYER);     // settle
        _tick(runId, CaptainDownBad.Move.Jump, _salt(0, 1), PLAYER); // jump

        (, uint8 posY1, int8 velY1,,,) = _unpack(_playerState(runId));
        assertGt(velY1, 0, "airborne after first jump");

        // Attempt second jump while airborne — velY != 0, so ignored
        _tick(runId, CaptainDownBad.Move.Jump, _salt(0, 2), PLAYER);

        (, uint8 posY2, int8 velY2,,,) = _unpack(_playerState(runId));
        // If double-jump worked, velY would spike back up. It should continue falling.
        assertLt(velY2, velY1, "velY decreasing - no double jump");
        assertLt(posY2, posY1, "still moving up (or same height, not reset)");
    }

    function test_moveLeft_decrementsPosX() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Left, SALT, PLAYER);

        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 1, "posX decremented");
    }

    function test_moveRight_incrementsPosX() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Right, SALT, PLAYER);

        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 3, "posX incremented");
    }

    function test_moveLeft_atXZero_stays() public {
        // Build level where player can't go left of x=0
        uint256 runId = _startRun(PLAYER, BET, 0);

        // Move left twice to reach x=0
        _tick(runId, CaptainDownBad.Move.Left, _salt(0,0), PLAYER);
        _tick(runId, CaptainDownBad.Move.Left, _salt(0,1), PLAYER);

        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 0, "at left boundary");

        _tick(runId, CaptainDownBad.Move.Left, _salt(0,2), PLAYER);
        (uint8 posX2,,,,,) = _unpack(_playerState(runId));
        assertEq(posX2, 0, "can't go past x=0");
    }

    function test_moveRight_atBoundary_stays() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        // Walk to x=31 (LEVEL_WIDTH-1) — 29 right moves from x=2
        for (uint256 i; i < 29; i++) {
            _tick(runId, CaptainDownBad.Move.Right, _salt(0, i), PLAYER);
        }
        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 31);

        _tick(runId, CaptainDownBad.Move.Right, _salt(0, 30), PLAYER);
        (uint8 posX2,,,,,) = _unpack(_playerState(runId));
        assertEq(posX2, 31, "can't go past x=31");
    }

    function test_terminalVelocity_clamp() public {
        // Level = all air. Player falls indefinitely.
        bytes memory tiles = new bytes(LEVEL_W * LEVEL_H); // all zeros = all air
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);

        // 10 idle ticks — velY should clamp at -8 (TERMINAL_VELOCITY)
        for (uint256 i; i < 10; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, _salt(0, i), PLAYER);
        }

        (,, int8 velY,,,) = _unpack(_playerState(runId));
        assertEq(velY, -8, "terminal velocity clamped at -8");
    }

    // =========================================================================
    // Gem collection
    // =========================================================================

    function test_collectGem_scoreIncreasesBy100() public {
        // Gem at (2,15) — player falls from y=14 with velY=-1 → nextY=15 → GEM
        bytes memory tiles = _buildLevel(2, 15, 2); // TILE_GEM
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);

        // Commit first, then set expectEmit before the reveal (which triggers the tick)
        bytes32 hash = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));
        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.expectEmit(true, false, false, true);
        emit CaptainDownBad.GemCollected(runId, 2, 15, 100);

        vm.prank(PLAYER);
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);

        (,,,,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score, 100, "GEM_SCORE = 100");
    }

    function test_collectGem_perRunIsolation() public {
        // Two players on same level with a gem — collecting in run A doesn't consume it for run B
        bytes memory tiles = _buildLevel(2, 15, 2);
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runA = _startRun(PLAYER,  BET, 1);
        uint256 runB = _startRun(PLAYER2, BET, 1);

        // Player A collects the gem
        _tick(runA, CaptainDownBad.Move.Idle, _salt(1, 0), PLAYER);
        (,,,,, uint56 scoreA) = _unpack(_playerState(runA));
        assertEq(scoreA, 100, "run A collected gem");

        // Player B should also be able to collect the gem (separate _cleared mapping)
        _tick(runB, CaptainDownBad.Move.Idle, _salt(2, 0), PLAYER2);
        (,,,,, uint56 scoreB) = _unpack(_playerState(runB));
        assertEq(scoreB, 100, "run B gem unaffected by run A");
    }

    function test_collectGem_onlyOncePerRun() public {
        bytes memory tiles = _buildLevel(2, 15, 2);
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);

        // First pass collects the gem
        _tick(runId, CaptainDownBad.Move.Idle, _salt(0,0), PLAYER);
        (,,,,, uint56 score1) = _unpack(_playerState(runId));
        assertEq(score1, 100);

        // Second pass over same tile — gem is cleared, tile is now air → score unchanged
        _tick(runId, CaptainDownBad.Move.Idle, _salt(0,1), PLAYER);
        (,,,,, uint56 score2) = _unpack(_playerState(runId));
        assertEq(score2, 100, "gem already cleared, score unchanged");
    }

    // =========================================================================
    // Damage tiles
    // =========================================================================

    function test_spikeDamage_reducesHealthBy1() public {
        // Spike at (2,15)
        bytes memory tiles = _buildLevel(2, 15, 3); // TILE_SPIKE
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);
        _tick(runId, CaptainDownBad.Move.Idle, SALT, PLAYER);

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 2, "health reduced by 1 from spike");
    }

    function test_enemyDamage_reducesHealthBy1() public {
        // Enemy at (2,15)
        bytes memory tiles = _buildLevel(2, 15, 4); // TILE_ENEMY
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);
        _tick(runId, CaptainDownBad.Move.Idle, SALT, PLAYER);

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 2, "health reduced by 1 from enemy");
    }

    // =========================================================================
    // Death & payout
    // =========================================================================

    function test_healthZero_runBecomesInactive() public {
        // 3 spikes (health=3): run should end after 3 hits
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);

        for (uint256 i; i < 3; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, _salt(0, i), PLAYER);
        }

        assertFalse(_isActive(runId), "run should be inactive after death");
    }

    function test_healthZero_betGoesToHouseFees() public {
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);

        for (uint256 i; i < 3; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, _salt(0, i), PLAYER);
        }

        assertEq(game.houseFees(), BET, "full bet goes to houseFees on loss");
    }

    function test_houseFees_neverExceedContractBalance() public {
        // Two players die → houseFees = 2*BET = contract balance
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runA = _startRun(PLAYER,  BET, 1);
        uint256 runB = _startRun(PLAYER2, BET, 1);

        for (uint256 i; i < 3; i++) {
            _tick(runA, CaptainDownBad.Move.Idle, _salt(1, i), PLAYER);
            _tick(runB, CaptainDownBad.Move.Idle, _salt(2, i), PLAYER2);
        }

        assertLe(game.houseFees(), usdc.balanceOf(address(game)), "houseFees <= balance");
    }

    // =========================================================================
    // Attack animation
    // =========================================================================

    function test_punch_incrementsAnimFrame() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Punch, SALT, PLAYER);

        (,,,, uint8 animFrame,) = _unpack(_playerState(runId));
        assertEq(animFrame, 1, "animFrame incremented on Punch");
    }

    function test_kick_incrementsAnimFrame() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Kick, SALT, PLAYER);

        (,,,, uint8 animFrame,) = _unpack(_playerState(runId));
        assertEq(animFrame, 1, "animFrame incremented on Kick");
    }

    function test_animFrame_wrapsAt4() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        for (uint256 i; i < 4; i++) {
            _tick(runId, CaptainDownBad.Move.Punch, _salt(0, i), PLAYER);
        }
        (,,,, uint8 animFrame,) = _unpack(_playerState(runId));
        assertEq(animFrame, 0, "animFrame wraps at 4");
    }

    // =========================================================================
    // Pause
    // =========================================================================

    function test_pause_blocksStartRun() public {
        vm.prank(OWNER);
        game.pause();

        usdc.mint(PLAYER, BET);
        vm.prank(PLAYER);
        usdc.approve(address(game), BET);
        vm.prank(PLAYER);
        vm.expectRevert();
        game.startRun(BET, 0);
    }

    function test_pause_blocksCommit() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(OWNER);
        game.pause();

        vm.prank(PLAYER);
        vm.expectRevert();
        game.commitMove(runId, bytes32("x"));
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function test_setLevel_happyPath() public {
        bytes memory tiles = _buildLevel(0, 0, 1);
        vm.prank(OWNER);
        vm.expectEmit(true, false, false, false);
        emit CaptainDownBad.LevelSet(5);
        game.setLevel(5, tiles);

        // Can start a run on the new level
        uint256 runId = _startRun(PLAYER, BET, 5);
        assertTrue(_isActive(runId));
    }

    function test_setLevel_wrongSize_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert("CDB: wrong level size");
        game.setLevel(1, new bytes(10));
    }

    function test_setLevel_notOwner_reverts() public {
        vm.prank(RANDO);
        vm.expectRevert();
        game.setLevel(1, new bytes(LEVEL_W * LEVEL_H));
    }

    function test_claimHouseFees() public {
        // Generate fees by killing a player
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles);

        uint256 runId = _startRun(PLAYER, BET, 1);
        for (uint256 i; i < 3; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, _salt(0, i), PLAYER);
        }

        assertEq(game.houseFees(), BET);

        vm.expectEmit(true, false, false, true);
        emit CaptainDownBad.HouseFeesClaimed(OWNER, BET);

        vm.prank(OWNER);
        game.claimHouseFees(OWNER);

        assertEq(game.houseFees(),        0,   "houseFees cleared");
        assertEq(usdc.balanceOf(OWNER),   BET, "owner received fees");
    }

    function test_claimHouseFees_notOwner_reverts() public {
        vm.prank(RANDO);
        vm.expectRevert();
        game.claimHouseFees(RANDO);
    }

    // =========================================================================
    // Fuzz: pack / unpack round-trip
    // =========================================================================

    function testFuzz_packUnpackRoundtrip(
        uint8  posX,
        uint8  posY,
        int8   velY,
        uint8  health,
        uint8  animFrame,
        uint56 score
    ) public pure {
        uint256 packed = _pack(posX, posY, velY, health, animFrame, score);
        (uint8 ux, uint8 uy, int8 uvy, uint8 uh, uint8 ua, uint56 us) = _unpack(packed);

        assertEq(ux,  posX,      "posX round-trip");
        assertEq(uy,  posY,      "posY round-trip");
        assertEq(uvy, velY,      "velY round-trip");
        assertEq(uh,  health,    "health round-trip");
        assertEq(ua,  animFrame, "animFrame round-trip");
        assertEq(us,  score,     "score round-trip");
    }

    // =========================================================================
    // Fuzz: random move sequences — payout + bounds invariants
    // =========================================================================

    function testFuzz_randomMoveSequence(uint256 seed) public {
        // Use a flat level (all air) so the fuzz can explore all tile=0 paths
        // without dying from spikes on the default level.
        bytes memory tiles = new bytes(LEVEL_W * LEVEL_H); // all air
        vm.prank(OWNER);
        game.setLevel(2, tiles);

        uint256 totalDeposited;

        // Three players, each with a run
        address[3] memory players = [PLAYER, PLAYER2, address(0xCAFE)];
        uint256[3] memory runIds;

        for (uint256 p; p < 3; p++) {
            uint256 bet = BET * (p + 1);
            totalDeposited += bet;
            runIds[p] = _startRun(players[p], bet, 2);
        }

        // 20 ticks of random moves per player
        for (uint256 i; i < 20; i++) {
            for (uint256 p; p < 3; p++) {
                if (!_isActive(runIds[p])) continue;

                uint8 moveIdx = uint8((uint256(keccak256(abi.encodePacked(seed, p, i)))) % 6);
                CaptainDownBad.Move move = CaptainDownBad.Move(moveIdx);
                bytes32 s = _salt(seed ^ (p * 1337), i);

                _tick(runIds[p], move, s, players[p]);

                if (!_isActive(runIds[p])) continue;

                // Per-tick invariants
                (uint8 px, uint8 py, int8 vy, uint8 hp,,) = _unpack(_playerState(runIds[p]));
                assertLe(px, 31,  "posX in bounds");
                assertLe(py, 15,  "posY in bounds");
                assertGe(vy, -8,  "velY >= terminal velocity");
                assertGt(hp, 0,   "active run implies health > 0");
            }
        }

        // Global invariant: house never over-collects
        assertLe(game.houseFees(), usdc.balanceOf(address(game)), "solvency: fees <= balance");
        assertLe(game.houseFees(), totalDeposited, "fees <= total deposited");
    }

    // =========================================================================
    // Gap 1: _endRun(won=true) — winning payout block
    // =========================================================================

    function test_winPayout_multiplierAndFee() public {
        // score=0: multiplierBps=10000, gross=BET, fee=BET*1%=50000, payout=BET-50000
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(OWNER);
        game.exposed_endRun(runId, true);

        uint256 expectedFee    = BET * 100 / 10_000;           // 50_000
        uint256 expectedPayout = BET - expectedFee;             // 4_950_000

        assertEq(game.houseFees(),            expectedFee,    "1% house fee");
        assertEq(usdc.balanceOf(PLAYER),      expectedPayout, "player payout");
        assertFalse(_isActive(runId),                          "run marked inactive");

        (,,,,,,,, uint256 finalScore) = game.runs(runId);
        assertEq(finalScore, 0, "finalScore recorded");
    }

    function test_winPayout_emitsRunEnded() public {
        uint256 runId      = _startRun(PLAYER, BET, 0);
        uint256 expectedFee    = BET * 100 / 10_000;
        uint256 expectedPayout = BET - expectedFee;

        vm.expectEmit(true, true, false, true);
        emit CaptainDownBad.RunEnded(runId, PLAYER, expectedPayout, 0, true);

        vm.prank(OWNER);
        game.exposed_endRun(runId, true);
    }

    function test_winPayout_cappedByAvailableBalance() public {
        // Fund contract with extra treasury so cap math works without underflow:
        //   balance = BET(bet) + BET(treasury) = 10e6
        //   score   = 1_000_000 → gross = BET * 1_010_000/10_000 = 505e6 >> balance
        //   fee     = 505e6 * 1% = 5_050_000 → houseFees = 5_050_000
        //   available = 10e6 - 5_050_000 = 4_950_000
        //   payout capped from 499_950_000 → 4_950_000
        uint256 runId = _startRun(PLAYER, BET, 0);
        usdc.mint(address(game), BET); // treasury supplement

        vm.prank(OWNER);
        game.exposed_setScore(runId, 1_000_000);

        vm.prank(OWNER);
        game.exposed_endRun(runId, true);

        uint256 expectedFee       = (BET * 1_010_000 / 10_000) * 100 / 10_000; // 5_050_000
        uint256 expectedAvailable = (BET + BET) - expectedFee;                  // 4_950_000

        assertEq(usdc.balanceOf(PLAYER), expectedAvailable, "payout capped to available");
        assertEq(game.houseFees(),       expectedFee,       "fee retained in houseFees");
        // Contract fully solvent: balance remaining == houseFees
        assertEq(usdc.balanceOf(address(game)), expectedFee, "contract balance = houseFees");
    }

    // =========================================================================
    // Gap 2: missing revealAndAdvance + advanceExpired revert branches
    // =========================================================================

    function test_revealAndAdvance_inactive_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));
        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        // Force-end the run while commit is still pending
        vm.prank(OWNER);
        game.exposed_endRun(runId, false);

        vm.prank(PLAYER);
        vm.expectRevert("CDB: inactive");
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);
    }

    function test_revealAndAdvance_notOwner_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));
        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.prank(RANDO);
        vm.expectRevert("CDB: not your run");
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);
    }

    function test_revealAndAdvance_noCommit_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        // No commitMove call — commit slot is bytes32(0)
        vm.prank(PLAYER);
        vm.expectRevert("CDB: no commit");
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);
    }

    function test_advanceExpired_inactiveRun_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        bytes32 hash  = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));
        vm.prank(PLAYER);
        game.commitMove(runId, hash); // commit is set

        // Force-end the run; commit remains non-zero, run becomes inactive
        vm.prank(OWNER);
        game.exposed_endRun(runId, false);

        vm.warp(block.timestamp + 121); // past reveal window
        vm.expectRevert("CDB: inactive");
        game.advanceExpired(runId);
    }

    // =========================================================================
    // Gap 3: unpause()
    // =========================================================================

    function test_unpause_allowsGameActions() public {
        vm.prank(OWNER);
        game.pause();
        assertTrue(game.paused(), "should be paused");

        vm.prank(OWNER);
        game.unpause();
        assertFalse(game.paused(), "should be unpaused");

        // Verify game actions are unblocked
        uint256 runId = _startRun(PLAYER, BET, 0);
        assertTrue(_isActive(runId), "can start run after unpause");
    }

    // =========================================================================
    // Real level mechanics — LEVEL_MAP_BYTES + new game logic
    // =========================================================================

    /// @dev Player falls into a gem tile on tick 1. Verifies score += GEM_SCORE and
    ///      GemCollected event; run stays active (levelId=1, no all-gems win check).
    function test_collectGemAndScore() public {
        bytes memory lvl = _buildLevel(2, 15, 2 /* TILE_GEM */);
        vm.prank(OWNER);
        game.setLevel(1, lvl);

        uint256 runId = _startRun(PLAYER, BET, 1);

        // Commit first, then arm expectEmit, then reveal — GemCollected fires in revealAndAdvance
        bytes32 hash = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));
        vm.prank(PLAYER);
        game.commitMove(runId, hash);

        vm.expectEmit(true, false, false, true); // check runId + all data fields
        emit CaptainDownBad.GemCollected(runId, 2, 15, game.GEM_SCORE());

        vm.prank(PLAYER);
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);

        (,,,,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score,  uint56(game.GEM_SCORE()), "score +GEM_SCORE after collecting gem");
        assertTrue(_isActive(runId),               "run still active after gem collect");
    }

    /// @dev Three consecutive spike hits drain INITIAL_HEALTH=3 to 0, ending the run.
    ///      Each tick the player remains on the spike tile (no floor wall to bounce off).
    function test_spikeDamage() public {
        bytes memory lvl = _buildLevel(2, 15, 3 /* TILE_SPIKE */);
        vm.prank(OWNER);
        game.setLevel(1, lvl);

        uint256 runId = _startRun(PLAYER, BET, 1);

        _tick(runId, CaptainDownBad.Move.Idle, _salt(7, 0), PLAYER); // health 3→2
        _tick(runId, CaptainDownBad.Move.Idle, _salt(7, 1), PLAYER); // health 2→1

        // Arm expectEmit between commit and reveal so RunEnded is the next event checked
        bytes32 h3 = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, _salt(7, 2), PLAYER));
        vm.prank(PLAYER);
        game.commitMove(runId, h3);

        vm.expectEmit(true, true, false, false);
        emit CaptainDownBad.RunEnded(runId, PLAYER, 0, 0, false);

        vm.prank(PLAYER);
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, _salt(7, 2)); // health 1→0 → loss

        assertFalse(_isActive(runId), "run ends when health hits 0");

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 0, "health is 0 after fatal spike damage");
    }

    /// @dev Punch on an enemy tile defeats the troll: score += ENEMY_SCORE, tile cleared.
    ///      A subsequent Idle tick at the same position deals no damage (tile is air).
    function test_enemyPunchKO() public {
        bytes memory lvl = _buildLevel(2, 15, 4 /* TILE_ENEMY */);
        vm.prank(OWNER);
        game.setLevel(1, lvl);

        uint256 runId = _startRun(PLAYER, BET, 1);

        // Tick 1: Punch on enemy tile — defeat the troll
        _tick(runId, CaptainDownBad.Move.Punch, SALT, PLAYER);

        (,,, uint8 healthAfterKO,, uint56 scoreAfterKO) = _unpack(_playerState(runId));
        assertEq(scoreAfterKO,  uint56(game.ENEMY_SCORE()), "score +ENEMY_SCORE on KO");
        assertEq(healthAfterKO, 3,                          "no damage taken when attacking");

        // Tick 2: Idle on same position — cleared tile is now air, no effect
        _tick(runId, CaptainDownBad.Move.Idle, _salt(42, 0), PLAYER);

        (,,, uint8 healthAfterIdle,,) = _unpack(_playerState(runId));
        assertEq(healthAfterIdle, 3, "health unchanged - cleared enemy no longer harms");
    }

    /// @dev Collect all 4 Magical D gems via harness shortcut then tick once.
    ///      Win condition fires → _endRun(won=true) → player receives bet minus house fee.
    ///      Replaces test_winBottomExit (posY>=15 condition was removed as it collided with
    ///      custom test levels that lack a ground row).
    function test_winAllGemsCleared() public {
        uint256 runId = _startRun(PLAYER, BET, 0); // level 0 = LEVEL_MAP_BYTES

        // Force-clear all 4 gem tile positions (matches GEM_IDX_0..3 constants)
        game.exposed_clearTileByXY(runId, 10,  8);
        game.exposed_clearTileByXY(runId, 12,  8);
        game.exposed_clearTileByXY(runId, 18, 10);
        game.exposed_clearTileByXY(runId, 20, 10);

        // Arm expectEmit between commit and reveal so RunEnded is the next event checked
        bytes32 h = keccak256(abi.encodePacked(CaptainDownBad.Move.Idle, SALT, PLAYER));
        vm.prank(PLAYER);
        game.commitMove(runId, h);

        vm.expectEmit(true, true, false, false);
        emit CaptainDownBad.RunEnded(runId, PLAYER, 0, 0, true);

        vm.prank(PLAYER);
        game.revealAndAdvance(runId, CaptainDownBad.Move.Idle, SALT);

        assertFalse(_isActive(runId), "run ends when all gems are cleared");

        // score=0 → multiplier=1×, gross=BET, fee=1%, payout=BET*99/100
        uint256 expectedPayout = BET - BET * game.HOUSE_FEE_BPS() / game.BPS_DENOM();
        assertEq(usdc.balanceOf(PLAYER), expectedPayout, "player receives bet minus house fee");
        assertEq(game.houseFees(), BET - expectedPayout, "house fee accrued correctly");
    }

    /// @dev Closes two coverage gaps introduced by the LEVEL_MAP_BYTES refactor:
    ///      1. Enemy-defeat branch: Punch=false AND Kick=true path in _advanceTick.
    ///      2. getTile public entry-point: direct external call not exercised elsewhere.
    function test_enemyKickKO_and_getTile_direct() public {
        // --- Part 1: Kick defeats enemy (Punch=false AND Kick=true branch) ---
        bytes memory lvl = _buildLevel(2, 15, 4 /* TILE_ENEMY */);
        vm.prank(OWNER);
        game.setLevel(1, lvl);

        uint256 runId = _startRun(PLAYER, BET, 1);
        _tick(runId, CaptainDownBad.Move.Kick, SALT, PLAYER);

        (,,, uint8 health,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score,  uint56(game.ENEMY_SCORE()), "Kick defeats enemy: score += ENEMY_SCORE");
        assertEq(health, 3,                          "Kick defeats enemy: no damage taken");

        // --- Part 2: getTile public entry-point (covers the function directly) ---
        assertEq(game.getTile(8,   8), 4, "getTile: enemy  at (8,8)  in LEVEL_MAP_BYTES");
        assertEq(game.getTile(10,  8), 2, "getTile: gem    at (10,8) in LEVEL_MAP_BYTES");
        assertEq(game.getTile(0,  15), 1, "getTile: wall   at (0,15) ground row");
        assertEq(game.getTile(255, 0), 0, "getTile: out-of-bounds -> TILE_AIR");
    }
}
