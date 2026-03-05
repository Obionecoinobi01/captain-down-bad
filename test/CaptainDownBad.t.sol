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

    // ---- Bit shifts (mirror contract private constants) ----
    uint256 constant POS_X_SHIFT  = 248;
    uint256 constant POS_Y_SHIFT  = 240;
    uint256 constant VEL_Y_SHIFT  = 232;
    uint256 constant HEALTH_SHIFT = 224;
    uint256 constant ANIM_SHIFT   = 216;
    uint256 constant SCORE_MASK   = type(uint56).max;

    // ---- Test actors ----
    address constant OWNER      = address(0xA11CE);
    address constant PLAYER     = address(0xB0B);
    address constant PLAYER2    = address(0xC4C);
    address constant RANDO      = address(0xDEAD);
    address constant SESSION_KEY = address(0x5E55);

    CaptainDownBadHarness game;  // harness IS-A CaptainDownBad
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

    /// @dev Submit a move as the given caller (player or session key).
    function _tick(uint256 runId, CaptainDownBad.Move move, address caller) internal {
        vm.prank(caller);
        game.submitMove(runId, move);
    }

    /// @dev Read playerState from run tuple (field index 4 in 7-field struct).
    function _playerState(uint256 runId) internal view returns (uint256) {
        (,,,, uint256 ps,,) = game.runs(runId);
        return ps;
    }

    function _isActive(uint256 runId) internal view returns (bool) {
        (,,,,, bool a,) = game.runs(runId);
        return a;
    }

    // =========================================================================
    // startRun
    // =========================================================================

    function test_startRun_happyPath() public {
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
    // authorizeSessionKey
    // =========================================================================

    function test_authorizeSessionKey_happyPath() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.expectEmit(true, true, false, false);
        emit CaptainDownBad.SessionKeySet(runId, SESSION_KEY);

        vm.prank(PLAYER);
        game.authorizeSessionKey(runId, SESSION_KEY);

        assertEq(game.sessionKeys(runId), SESSION_KEY, "session key stored");
    }

    function test_authorizeSessionKey_notOwner_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        vm.prank(RANDO);
        vm.expectRevert("CDB: not your run");
        game.authorizeSessionKey(runId, SESSION_KEY);
    }

    function test_authorizeSessionKey_inactive_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        vm.prank(OWNER);
        game.exposed_endRun(runId, false);

        vm.prank(PLAYER);
        vm.expectRevert("CDB: inactive");
        game.authorizeSessionKey(runId, SESSION_KEY);
    }

    function test_authorizeSessionKey_zeroAddress_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        vm.prank(PLAYER);
        vm.expectRevert("CDB: zero key");
        game.authorizeSessionKey(runId, address(0));
    }

    function test_authorizeSessionKey_canUpdate() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(PLAYER);
        game.authorizeSessionKey(runId, SESSION_KEY);

        address newKey = address(0xBEEF);
        vm.prank(PLAYER);
        game.authorizeSessionKey(runId, newKey);

        assertEq(game.sessionKeys(runId), newKey, "session key updated");
    }

    // =========================================================================
    // submitMove
    // =========================================================================

    function test_submitMove_byPlayer() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.expectEmit(true, false, false, true);
        emit CaptainDownBad.MovePlayed(runId, 0, CaptainDownBad.Move.Idle);

        vm.prank(PLAYER);
        game.submitMove(runId, CaptainDownBad.Move.Idle);

        (,,, uint256 tick,,,) = game.runs(runId);
        assertEq(tick, 1, "tick advanced");
    }

    function test_submitMove_bySessionKey() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(PLAYER);
        game.authorizeSessionKey(runId, SESSION_KEY);

        vm.prank(SESSION_KEY);
        game.submitMove(runId, CaptainDownBad.Move.Right);

        (,,, uint256 tick,,,) = game.runs(runId);
        assertEq(tick, 1, "session key advanced tick");
    }

    function test_submitMove_byRando_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        vm.prank(RANDO);
        vm.expectRevert("CDB: unauthorized");
        game.submitMove(runId, CaptainDownBad.Move.Idle);
    }

    function test_submitMove_inactive_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        vm.prank(OWNER);
        game.exposed_endRun(runId, false);

        vm.prank(PLAYER);
        vm.expectRevert("CDB: inactive");
        game.submitMove(runId, CaptainDownBad.Move.Idle);
    }

    function test_submitMove_paused_reverts() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(OWNER);
        game.pause();

        vm.prank(PLAYER);
        vm.expectRevert();
        game.submitMove(runId, CaptainDownBad.Move.Idle);
    }

    // =========================================================================
    // Gravity & landing (anti-tunnelling)
    // =========================================================================

    function test_gravity_onGround_staysAtY14() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (, uint8 posY, int8 velY,,,) = _unpack(_playerState(runId));
        assertEq(posY, 14, "should land back on y=14 above ground");
        assertEq(velY, 0,  "velY reset on wall hit");
    }

    function test_antiTunneling_wallRevertsPosition() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (uint8 px, uint8 py, int8 vy,,,) = _unpack(_playerState(runId));
        assertEq(px, 2,  "posX unchanged");
        assertEq(py, 14, "posY reverted, not tunnelled into wall");
        assertEq(vy, 0,  "velY zeroed on landing");
    }

    function test_jump_setsImpulse() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
        _tick(runId, CaptainDownBad.Move.Jump, PLAYER);

        (, uint8 posY, int8 velY,,,) = _unpack(_playerState(runId));
        assertEq(velY, 3,  "velY after jump impulse + gravity");
        assertEq(posY, 11, "posY moved up from 14");
    }

    function test_jump_cannotDoubleJump() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
        _tick(runId, CaptainDownBad.Move.Jump, PLAYER);

        (, uint8 posY1, int8 velY1,,,) = _unpack(_playerState(runId));
        assertGt(velY1, 0, "airborne after first jump");

        _tick(runId, CaptainDownBad.Move.Jump, PLAYER);

        (, uint8 posY2, int8 velY2,,,) = _unpack(_playerState(runId));
        assertLt(velY2, velY1, "velY decreasing - no double jump");
        assertLt(posY2, posY1, "still moving up");
    }

    function test_moveLeft_decrementsPosX() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Left, PLAYER);

        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 1, "posX decremented");
    }

    function test_moveRight_incrementsPosX() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Right, PLAYER);

        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 3, "posX incremented");
    }

    function test_moveLeft_atXZero_stays() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Left, PLAYER);
        _tick(runId, CaptainDownBad.Move.Left, PLAYER);

        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 0, "at left boundary");

        _tick(runId, CaptainDownBad.Move.Left, PLAYER);
        (uint8 posX2,,,,,) = _unpack(_playerState(runId));
        assertEq(posX2, 0, "can't go past x=0");
    }

    function test_moveRight_atBoundary_stays() public {
        // Use a clean level: only ground wall at y=15, no spikes or enemies
        bytes memory tiles = new bytes(LEVEL_W * LEVEL_H);
        for (uint256 x = 0; x < LEVEL_W; x++) {
            tiles[15 * LEVEL_W + x] = bytes1(uint8(1)); // WALL
        }
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);
        for (uint256 i; i < 29; i++) {
            _tick(runId, CaptainDownBad.Move.Right, PLAYER);
        }
        (uint8 posX,,,,,) = _unpack(_playerState(runId));
        assertEq(posX, 31);

        _tick(runId, CaptainDownBad.Move.Right, PLAYER);
        (uint8 posX2,,,,,) = _unpack(_playerState(runId));
        assertEq(posX2, 31, "can't go past x=31");
    }

    function test_terminalVelocity_clamp() public {
        bytes memory tiles = new bytes(LEVEL_W * LEVEL_H); // all air
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        for (uint256 i; i < 10; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
        }

        (,, int8 velY,,,) = _unpack(_playerState(runId));
        assertEq(velY, -8, "terminal velocity clamped at -8");
    }

    // =========================================================================
    // Gem collection
    // =========================================================================

    function test_collectGem_scoreIncreasesBy100() public {
        bytes memory tiles = _buildLevel(2, 15, 2); // TILE_GEM
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        vm.expectEmit(true, false, false, true);
        emit CaptainDownBad.GemCollected(runId, 2, 15, 100);

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,,,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score, 100, "GEM_SCORE = 100");
    }

    function test_collectGem_perRunIsolation() public {
        bytes memory tiles = _buildLevel(2, 15, 2);
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runA = _startRun(PLAYER,  BET, 1);
        uint256 runB = _startRun(PLAYER2, BET, 1);

        _tick(runA, CaptainDownBad.Move.Idle, PLAYER);
        (,,,,, uint56 scoreA) = _unpack(_playerState(runA));
        assertEq(scoreA, 100, "run A collected gem");

        _tick(runB, CaptainDownBad.Move.Idle, PLAYER2);
        (,,,,, uint56 scoreB) = _unpack(_playerState(runB));
        assertEq(scoreB, 100, "run B gem unaffected by run A");
    }

    function test_collectGem_onlyOncePerRun() public {
        bytes memory tiles = _buildLevel(2, 15, 2);
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
        (,,,,, uint56 score1) = _unpack(_playerState(runId));
        assertEq(score1, 100);

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
        (,,,,, uint56 score2) = _unpack(_playerState(runId));
        assertEq(score2, 100, "gem already cleared, score unchanged");
    }

    // =========================================================================
    // Damage tiles
    // =========================================================================

    function test_spikeDamage_reducesHealthBy1() public {
        bytes memory tiles = _buildLevel(2, 15, 3); // TILE_SPIKE
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 2, "health reduced by 1 from spike");
    }

    function test_enemyDamage_reducesHealthBy1() public {
        bytes memory tiles = _buildLevel(2, 15, 4); // TILE_ENEMY
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 2, "health reduced by 1 from enemy");
    }

    // =========================================================================
    // Death & payout
    // =========================================================================

    function test_healthZero_runBecomesInactive() public {
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        for (uint256 i; i < 3; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
        }

        assertFalse(_isActive(runId), "run should be inactive after death");
    }

    function test_healthZero_betGoesToHouseFees() public {
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        for (uint256 i; i < 3; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
        }

        assertEq(game.houseFees(), BET, "full bet goes to houseFees on loss");
    }

    function test_houseFees_neverExceedContractBalance() public {
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runA = _startRun(PLAYER,  BET, 1);
        uint256 runB = _startRun(PLAYER2, BET, 1);

        for (uint256 i; i < 3; i++) {
            _tick(runA, CaptainDownBad.Move.Idle, PLAYER);
            _tick(runB, CaptainDownBad.Move.Idle, PLAYER2);
        }

        assertLe(game.houseFees(), usdc.balanceOf(address(game)), "solvency: fees <= balance");
    }

    // =========================================================================
    // Attack animation
    // =========================================================================

    function test_punch_incrementsAnimFrame() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Punch, PLAYER);

        (,,,, uint8 animFrame,) = _unpack(_playerState(runId));
        assertEq(animFrame, 1, "animFrame incremented on Punch");
    }

    function test_kick_incrementsAnimFrame() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        _tick(runId, CaptainDownBad.Move.Kick, PLAYER);

        (,,,, uint8 animFrame,) = _unpack(_playerState(runId));
        assertEq(animFrame, 1, "animFrame incremented on Kick");
    }

    function test_animFrame_wrapsAt4() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        for (uint256 i; i < 4; i++) {
            _tick(runId, CaptainDownBad.Move.Punch, PLAYER);
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

    function test_pause_blocksSubmitMove() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(OWNER);
        game.pause();

        vm.prank(PLAYER);
        vm.expectRevert();
        game.submitMove(runId, CaptainDownBad.Move.Idle);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function test_setLevel_happyPath() public {
        bytes memory tiles = _buildLevel(0, 0, 1);
        vm.prank(OWNER);
        vm.expectEmit(true, false, false, false);
        emit CaptainDownBad.LevelSet(5);
        game.setLevel(5, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 5);
        assertTrue(_isActive(runId));
    }

    function test_setLevel_wrongSize_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert("CDB: wrong level size");
        game.setLevel(1, new bytes(10), 4);
    }

    function test_setLevel_notOwner_reverts() public {
        vm.prank(RANDO);
        vm.expectRevert();
        game.setLevel(1, new bytes(LEVEL_W * LEVEL_H), 4);
    }

    function test_claimHouseFees() public {
        bytes memory tiles = _buildLevel(2, 15, 3);
        vm.prank(OWNER);
        game.setLevel(1, tiles, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);
        for (uint256 i; i < 3; i++) {
            _tick(runId, CaptainDownBad.Move.Idle, PLAYER);
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
        bytes memory tiles = new bytes(LEVEL_W * LEVEL_H); // all air
        vm.prank(OWNER);
        game.setLevel(2, tiles, 4);

        uint256 totalDeposited;

        address[3] memory players = [PLAYER, PLAYER2, address(0xCAFE)];
        uint256[3] memory runIds;

        for (uint256 p; p < 3; p++) {
            uint256 bet = BET * (p + 1);
            totalDeposited += bet;
            runIds[p] = _startRun(players[p], bet, 2);
        }

        for (uint256 i; i < 20; i++) {
            for (uint256 p; p < 3; p++) {
                if (!_isActive(runIds[p])) continue;

                uint8 moveIdx = uint8((uint256(keccak256(abi.encodePacked(seed, p, i)))) % 6);
                CaptainDownBad.Move move = CaptainDownBad.Move(moveIdx);

                _tick(runIds[p], move, players[p]);

                if (!_isActive(runIds[p])) continue;

                (uint8 px, uint8 py, int8 vy, uint8 hp,,) = _unpack(_playerState(runIds[p]));
                assertLe(px, 31,  "posX in bounds");
                assertLe(py, 15,  "posY in bounds");
                assertGe(vy, -8,  "velY >= terminal velocity");
                assertGt(hp, 0,   "active run implies health > 0");
            }
        }

        assertLe(game.houseFees(), usdc.balanceOf(address(game)), "solvency: fees <= balance");
        assertLe(game.houseFees(), totalDeposited, "fees <= total deposited");
    }

    // =========================================================================
    // _endRun(won=true) — winning payout block
    // =========================================================================

    function test_winPayout_multiplierAndFee() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(OWNER);
        game.exposed_endRun(runId, true);

        uint256 expectedFee    = BET * 100 / 10_000;
        uint256 expectedPayout = BET - expectedFee;

        assertEq(game.houseFees(),            expectedFee,    "1% house fee");
        assertEq(usdc.balanceOf(PLAYER),      expectedPayout, "player payout");
        assertFalse(_isActive(runId),                          "run marked inactive");

        (,,,,,, uint256 finalScore) = game.runs(runId);
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
        uint256 runId = _startRun(PLAYER, BET, 0);
        usdc.mint(address(game), BET); // treasury supplement

        vm.prank(OWNER);
        game.exposed_setScore(runId, 1_000_000);

        vm.prank(OWNER);
        game.exposed_endRun(runId, true);

        uint256 expectedFee       = (BET * 1_010_000 / 10_000) * 100 / 10_000;
        uint256 expectedAvailable = (BET + BET) - expectedFee;

        assertEq(usdc.balanceOf(PLAYER), expectedAvailable, "payout capped to available");
        assertEq(game.houseFees(),       expectedFee,       "fee retained in houseFees");
        assertEq(usdc.balanceOf(address(game)), expectedFee, "contract balance = houseFees");
    }

    // =========================================================================
    // Unpause
    // =========================================================================

    function test_unpause_allowsGameActions() public {
        vm.prank(OWNER);
        game.pause();
        assertTrue(game.paused(), "should be paused");

        vm.prank(OWNER);
        game.unpause();
        assertFalse(game.paused(), "should be unpaused");

        uint256 runId = _startRun(PLAYER, BET, 0);
        assertTrue(_isActive(runId), "can start run after unpause");
    }

    // =========================================================================
    // Real level mechanics — LEVEL_MAP_BYTES
    // =========================================================================

    function test_collectGemAndScore() public {
        bytes memory lvl = _buildLevel(2, 15, 2 /* TILE_GEM */);
        vm.prank(OWNER);
        game.setLevel(1, lvl, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        vm.expectEmit(true, false, false, true);
        emit CaptainDownBad.GemCollected(runId, 2, 15, game.GEM_SCORE());

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,,,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score,  uint56(game.GEM_SCORE()), "score +GEM_SCORE after collecting gem");
        assertTrue(_isActive(runId),               "run still active after gem collect");
    }

    function test_spikeDamage() public {
        bytes memory lvl = _buildLevel(2, 15, 3 /* TILE_SPIKE */);
        vm.prank(OWNER);
        game.setLevel(1, lvl, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER); // health 3→2
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER); // health 2→1

        vm.expectEmit(true, true, false, false);
        emit CaptainDownBad.RunEnded(runId, PLAYER, 0, 0, false);

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER); // health 1→0 → loss

        assertFalse(_isActive(runId), "run ends when health hits 0");

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 0, "health is 0 after fatal spike damage");
    }

    function test_enemyPunchKO() public {
        bytes memory lvl = _buildLevel(2, 15, 4 /* TILE_ENEMY */);
        vm.prank(OWNER);
        game.setLevel(1, lvl, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);

        _tick(runId, CaptainDownBad.Move.Punch, PLAYER);

        (,,, uint8 healthAfterKO,, uint56 scoreAfterKO) = _unpack(_playerState(runId));
        assertEq(scoreAfterKO,  uint56(game.ENEMY_SCORE()), "score +ENEMY_SCORE on KO");
        assertEq(healthAfterKO, 3,                          "no damage taken when attacking");

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,, uint8 healthAfterIdle,,) = _unpack(_playerState(runId));
        assertEq(healthAfterIdle, 3, "health unchanged - cleared enemy no longer harms");
    }

    function test_winAllGemsCleared() public {
        uint256 runId = _startRun(PLAYER, BET, 0); // level 0 = LEVEL_MAP_BYTES

        game.exposed_clearTileByXY(runId, 10,  8);
        game.exposed_clearTileByXY(runId, 12,  8);
        game.exposed_clearTileByXY(runId, 18, 10);
        game.exposed_clearTileByXY(runId, 20, 10);

        vm.expectEmit(true, true, false, false);
        emit CaptainDownBad.RunEnded(runId, PLAYER, 0, 0, true);

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        assertFalse(_isActive(runId), "run ends when all gems are cleared");

        uint256 expectedPayout = BET - BET * game.HOUSE_FEE_BPS() / game.BPS_DENOM();
        assertEq(usdc.balanceOf(PLAYER), expectedPayout, "player receives bet minus house fee");
        assertEq(game.houseFees(), BET - expectedPayout, "house fee accrued correctly");
    }

    function test_enemyKickKO_and_getTile_direct() public {
        bytes memory lvl = _buildLevel(2, 15, 4 /* TILE_ENEMY */);
        vm.prank(OWNER);
        game.setLevel(1, lvl, 4);

        uint256 runId = _startRun(PLAYER, BET, 1);
        _tick(runId, CaptainDownBad.Move.Kick, PLAYER);

        (,,, uint8 health,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score,  uint56(game.ENEMY_SCORE()), "Kick defeats enemy: score += ENEMY_SCORE");
        assertEq(health, 3,                          "Kick defeats enemy: no damage taken");

        // Level 0 tile map: enemy 0 is now dynamic (patrol), tile (8,8) is air in the static map
        assertEq(game.getTile(8,   8), 0, "getTile: (8,8) is air; enemy 0 is dynamic patrol in level 0");
        assertEq(game.getTile(10,  8), 2, "getTile: gem    at (10,8) in LEVEL_MAP_BYTES");
        assertEq(game.getTile(0,  15), 1, "getTile: wall   at (0,15) ground row");
        assertEq(game.getTile(255, 0), 0, "getTile: out-of-bounds -> TILE_AIR");
    }

    // =========================================================================
    // Session key — move submission via ephemeral key
    // =========================================================================

    function test_sessionKey_fullRound() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        // Authorize session key
        vm.prank(PLAYER);
        game.authorizeSessionKey(runId, SESSION_KEY);

        // Session key submits several moves without player signing each one
        _tick(runId, CaptainDownBad.Move.Right, SESSION_KEY);
        _tick(runId, CaptainDownBad.Move.Right, SESSION_KEY);
        _tick(runId, CaptainDownBad.Move.Jump,  SESSION_KEY);

        (,,, uint256 tick,,,) = game.runs(runId);
        assertEq(tick, 3, "3 ticks advanced via session key");
        assertTrue(_isActive(runId), "run still active");
    }

    function test_sessionKey_oldKeyRejectedAfterUpdate() public {
        uint256 runId = _startRun(PLAYER, BET, 0);

        vm.prank(PLAYER);
        game.authorizeSessionKey(runId, SESSION_KEY);

        address newKey = address(0xBEEF);
        vm.prank(PLAYER);
        game.authorizeSessionKey(runId, newKey);

        // Old key should now be rejected
        vm.prank(SESSION_KEY);
        vm.expectRevert("CDB: unauthorized");
        game.submitMove(runId, CaptainDownBad.Move.Idle);

        // New key works
        vm.prank(newKey);
        game.submitMove(runId, CaptainDownBad.Move.Idle);
        (,,, uint256 tick,,,) = game.runs(runId);
        assertEq(tick, 1, "new session key accepted");
    }

    // =========================================================================
    // Enemy patrol — _enemyPosX() unit tests
    //
    // Enemy 0: pMin=8, pMax=14, spd=2, range=6
    //   phase  = (tick / 2) % 12
    //   offset = phase <= 6 ? phase : 12 - phase
    //
    // Enemy 1: pMin=6, pMax=24, spd=3, range=18
    //   phase  = (tick / 3) % 36
    //   offset = phase <= 18 ? phase : 36 - phase
    // =========================================================================

    function test_enemyPatrol_enemy0_specificTicks() public view {
        assertEq(game.exposed_enemyPosX(0, 0),  8,  "tick=0:  at patrolMin");
        assertEq(game.exposed_enemyPosX(0, 2),  9,  "tick=2:  step 1 right");
        assertEq(game.exposed_enemyPosX(0, 4),  10, "tick=4:  step 2 right");
        assertEq(game.exposed_enemyPosX(0, 12), 14, "tick=12: at patrolMax");
        assertEq(game.exposed_enemyPosX(0, 14), 13, "tick=14: step 1 back");
        assertEq(game.exposed_enemyPosX(0, 24), 8,  "tick=24: full cycle -> patrolMin");
    }

    function test_enemyPatrol_enemy1_specificTicks() public view {
        assertEq(game.exposed_enemyPosX(1, 0),   6,  "tick=0:   at patrolMin");
        assertEq(game.exposed_enemyPosX(1, 3),   7,  "tick=3:   step 1 right");
        assertEq(game.exposed_enemyPosX(1, 54),  24, "tick=54:  at patrolMax");
        assertEq(game.exposed_enemyPosX(1, 57),  23, "tick=57:  step 1 back");
        assertEq(game.exposed_enemyPosX(1, 108), 6,  "tick=108: full cycle -> patrolMin");
    }

    function testFuzz_enemyPatrol_alwaysInBounds(uint256 tick) public view {
        tick = bound(tick, 0, 10_000);
        uint8 x0 = game.exposed_enemyPosX(0, tick);
        assertGe(x0, 8,  "enemy0 posX never below patrolMin=8");
        assertLe(x0, 14, "enemy0 posX never above patrolMax=14");
        uint8 x1 = game.exposed_enemyPosX(1, tick);
        assertGe(x1, 6,  "enemy1 posX never below patrolMin=6");
        assertLe(x1, 24, "enemy1 posX never above patrolMax=24");
    }

    // =========================================================================
    // Enemy defeat — Punch/Kick with ±1 reach
    //
    // At tick=0, enemy 0 is at (posX=8, posY=8).
    // exposed_setPlayerXY teleports the player; velY stays 0 so gravity
    // drives nextY = posY - (-1) = 9, which hits the platform (TILE_WALL at y=9,
    // x=8..14), reverting posY back to 8. Player stays in row 8. ✓
    // =========================================================================

    function test_enemyDefeat_punchOnSameTile() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        game.exposed_setPlayerXY(runId, 8, 8); // same tile as enemy 0 at tick=0

        vm.expectEmit(true, true, false, true);
        emit CaptainDownBad.EnemyDefeated(runId, 0, uint256(game.ENEMY_SCORE()));

        _tick(runId, CaptainDownBad.Move.Punch, PLAYER);

        (,,, uint8 health,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score,  uint56(game.ENEMY_SCORE()), "score += ENEMY_SCORE on defeat");
        assertEq(health, 3,                          "no self-damage when attacking");
        assertEq(game.enemyDefeated(runId) & 1, 1,  "bit 0 set in defeat bitmask");
    }

    function test_enemyDefeat_kickOnSameTile() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        game.exposed_setPlayerXY(runId, 8, 8);

        _tick(runId, CaptainDownBad.Move.Kick, PLAYER);

        assertEq(game.enemyDefeated(runId) & 1, 1,  "kick defeats enemy on same tile");
        (,,,,, uint56 score) = _unpack(_playerState(runId));
        assertEq(score, uint56(game.ENEMY_SCORE()), "score += ENEMY_SCORE on kick defeat");
    }

    function test_enemyDefeat_punchFromAdjacentTile() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        game.exposed_setPlayerXY(runId, 9, 8); // dx=1 from enemy at x=8

        _tick(runId, CaptainDownBad.Move.Punch, PLAYER);

        assertEq(game.enemyDefeated(runId) & 1, 1, "punch from adjacent tile (dx=1) defeats enemy");
    }

    function test_enemyDefeat_punchTooFar_noDefeat() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        game.exposed_setPlayerXY(runId, 11, 8); // dx=3 from enemy at x=8 — out of ±1 reach

        _tick(runId, CaptainDownBad.Move.Punch, PLAYER);

        assertEq(game.enemyDefeated(runId) & 1, 0, "punch from dx=3 does not defeat enemy");
    }

    // =========================================================================
    // Enemy damage — touching enemy tile without attacking
    // =========================================================================

    function test_enemyDamage_idleOnEnemyTile() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        game.exposed_setPlayerXY(runId, 8, 8); // exact tile of enemy 0 at tick=0

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 2, "health 3->2 when touching enemy without attacking");
    }

    function test_enemyDamage_adjacentTile_noHarm() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        game.exposed_setPlayerXY(runId, 9, 8); // adjacent (dx=1) — damage zone is exact tile only

        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 3, "adjacent tile is safe for non-attacking moves");
    }

    // =========================================================================
    // Defeated enemy persistence — no longer harms after bit set
    // =========================================================================

    function test_defeatedEnemy_noLongerHarms() public {
        uint256 runId = _startRun(PLAYER, BET, 0);
        game.exposed_setPlayerXY(runId, 8, 8);

        // Defeat enemy 0 with Punch
        _tick(runId, CaptainDownBad.Move.Punch, PLAYER);
        assertEq(game.enemyDefeated(runId) & 1, 1, "enemy 0 defeated");

        // Player stays at (8,8); idle on the same tile — defeat bit prevents damage
        _tick(runId, CaptainDownBad.Move.Idle, PLAYER);

        (,,, uint8 health,,) = _unpack(_playerState(runId));
        assertEq(health, 3, "defeated enemy no longer harms the player");
    }
}
