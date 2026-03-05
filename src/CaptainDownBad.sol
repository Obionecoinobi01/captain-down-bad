// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable}        from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20}          from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}       from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title  CaptainDownBad — Hunt For the Magical D
 * @notice Fully on-chain turn-based pixel platformer on Base.
 *         Captain Down Bad hunts glowing Magical D gems across neon pixel levels.
 *
 * @dev    Game loop: session-key based moves (one MetaMask sig to start, then
 *         moves submitted silently by an ephemeral key held in the browser).
 *         All player state packed into one uint256 storage slot.
 *
 *         Packed uint256 layout (high-to-low):
 *           bits 255:248  posX       uint8   — horizontal tile position
 *           bits 247:240  posY       uint8   — vertical tile position (0=top, 15=bottom)
 *           bits 239:232  velY       int8    — physics velocity, positive=up, negative=down
 *           bits 231:224  health     uint8
 *           bits 223:216  animFrame  uint8
 *           bits  55:0    score      uint56
 *
 *         Tile flags: 0=air 1=wall/platform 2=Magical-D-gem 3=spike 4=enemy
 *         Gravity:    velY -= 1 per tick; terminal = -8
 *         Positions:  posY increases downward (screen coords); velY physics sign → posY -= velY
 */
contract CaptainDownBad is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @dev USDC token — set at deploy time (mainnet: 0x833589…/ sepolia: 0x036CbD…)
    IERC20 public immutable USDC;

    uint256 public constant HOUSE_FEE_BPS      = 100;   // 1 %
    uint256 public constant BPS_DENOM          = 10_000;
    uint256 public constant LEVEL_WIDTH        = 32;
    uint256 public constant LEVEL_HEIGHT       = 16;
    uint8   public constant INITIAL_HEALTH     = 3;
    int8    public constant JUMP_IMPULSE       = 4;
    int8    public constant TERMINAL_VELOCITY  = -8;
    uint256 public constant GEM_SCORE          = 100;
    uint256 public constant ENEMY_SCORE        = 100; // defeating an enemy with Punch/Kick

    // -------------------------------------------------------------------------
    // Level 0 — row-major flat bytes constant
    // -------------------------------------------------------------------------
    //
    //  512 bytes, row-major: LEVEL_MAP_BYTES[y * LEVEL_WIDTH + x] = tile at (x,y).
    //  Tile key: 0=air  1=wall  2=gem  3=spike  4=enemy
    //
    //  Starter level (32 wide × 16 tall):
    //    y=15           solid ground all columns
    //    y= 9, x=8-14  floating platform
    //    y= 8, x=10,12 Magical D gems (above platform)
    //    y= 8, x=8-14  enemy 0 patrol zone (dynamic — NOT in tile map)
    //    y=11, x=16-22 second floating platform
    //    y=10, x=18,20 Magical D gems (above second platform)
    //    y=14, x= 5    spike trap near ground
    //    y=14, x=25    spike trap near ground
    //    y=14, x=6-24  enemy 1 patrol zone (dynamic — NOT in tile map)
    //
    //  4 Magical D gems → LEVEL_0_GEM_COUNT = 4
    //  Enemies are dynamic (patrol computed from tick) — no tile 4 in map
    //
    bytes private constant LEVEL_MAP_BYTES = hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=0
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=1
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=2
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=3
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=4
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=5
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=6
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=7
        hex"0000000000000000000002000200000000000000000000000000000000000000"  // y=8  (enemy 0 removed from tile)
        hex"0000000000000000010101010101010000000000000000000000000000000000"  // y=9
        hex"0000000000000000000000000000000000000200020000000000000000000000"  // y=10
        hex"0000000000000000000000000000000001010101010101000000000000000000"  // y=11
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=12
        hex"0000000000000000000000000000000000000000000000000000000000000000"  // y=13
        hex"0000000000030000000000000000000000000000000000000003000000000000"  // y=14  (enemy 1 removed from tile)
        hex"0101010101010101010101010101010101010101010101010101010101010101"; // y=15

    /// @dev Gem tile indices (row-major: y*LEVEL_WIDTH+x) for fast win check.
    uint256 private constant GEM_IDX_0 = 8 * 32 + 10; // (10,  8)
    uint256 private constant GEM_IDX_1 = 8 * 32 + 12; // (12,  8)
    uint256 private constant GEM_IDX_2 = 10 * 32 + 18; // (18, 10)
    uint256 private constant GEM_IDX_3 = 10 * 32 + 20; // (20, 10)
    uint256 private constant LEVEL_0_GEM_COUNT = 4;

    // -------------------------------------------------------------------------
    // Packed state — bit positions
    // -------------------------------------------------------------------------

    uint256 private constant POS_X_SHIFT  = 248;
    uint256 private constant POS_Y_SHIFT  = 240;
    uint256 private constant VEL_Y_SHIFT  = 232;
    uint256 private constant HEALTH_SHIFT = 224;
    uint256 private constant ANIM_SHIFT   = 216;
    uint256 private constant SCORE_MASK   = type(uint56).max; // bits 55:0

    // -------------------------------------------------------------------------
    // Tile flags
    // -------------------------------------------------------------------------

    uint8 private constant TILE_AIR   = 0;
    uint8 private constant TILE_WALL  = 1;
    uint8 private constant TILE_GEM   = 2; // Magical D — collect for score
    uint8 private constant TILE_SPIKE = 3; // damage on contact
    uint8 private constant TILE_ENEMY = 4; // static enemy (custom levels); level 0 uses dynamic patrol

    // -------------------------------------------------------------------------
    // Enemy patrol constants (level 0)
    // Enemies are NOT stored in the tile map — their positions are computed
    // deterministically from (enemyIndex, tick) using a ping-pong patrol.
    // -------------------------------------------------------------------------

    uint8 private constant ENEMY_COUNT        = 2;
    // Enemy 0: platform troll (patrols row y=8, above the first platform)
    uint8 private constant ENEMY_0_Y          = 8;
    uint8 private constant ENEMY_0_PATROL_MIN = 8;
    uint8 private constant ENEMY_0_PATROL_MAX = 14;
    uint8 private constant ENEMY_0_SPEED      = 2;  // moves every 2 ticks
    // Enemy 1: ground troll (patrols row y=14, wide ground sweep)
    uint8 private constant ENEMY_1_Y          = 14;
    uint8 private constant ENEMY_1_PATROL_MIN = 6;
    uint8 private constant ENEMY_1_PATROL_MAX = 24;
    uint8 private constant ENEMY_1_SPEED      = 3;  // moves every 3 ticks

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @notice The six moves a player can submit per tick.
    enum Move { Idle, Left, Right, Jump, Punch, Kick }

    /**
     * @notice Per-run state. One Run per session; new run = new runId.
     * @param player         Address that owns this run.
     * @param levelId        Which level is being played.
     * @param bet            USDC entry fee (6 decimals).
     * @param tick           Current game tick counter.
     * @param playerState    Packed uint256 (see layout above).
     * @param active         False once the run ends.
     * @param finalScore     Populated on run end.
     */
    struct Run {
        address player;
        uint256 levelId;
        uint256 bet;
        uint256 tick;
        uint256 playerState;
        bool    active;
        uint256 finalScore;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @notice All runs by ID.
    mapping(uint256 => Run) public runs;
    uint256 public nextRunId;

    /// @notice Session keys: runId → authorized ephemeral address.
    ///         The session key can submit moves on behalf of the player
    ///         without requiring a MetaMask popup for every move.
    mapping(uint256 => address) public sessionKeys;

    /// @notice Level tile data: levelId → LEVEL_WIDTH*LEVEL_HEIGHT bytes.
    mapping(uint256 => bytes) public levels;

    /// @notice Required gem count to win a custom level (levelId > 0).
    mapping(uint256 => uint256) public levelGemCounts;

    /// @dev Per-run consumed tiles (gems collected). Avoids mutating shared level data.
    mapping(uint256 runId => mapping(uint256 tileIdx => bool)) private _cleared;

    /// @dev Per-run enemy defeat bitmask. Bit i = 1 means enemy i is defeated.
    ///      Defaults to 0 (all alive). Max 8 enemies per level (uint8).
    mapping(uint256 runId => uint8) private _defeated;

    /// @notice Claimable by owner; accumulates entry fees from lost runs + house cuts.
    uint256 public houseFees;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event RunStarted(uint256 indexed runId, address indexed player, uint256 bet, uint256 levelId);
    event SessionKeySet(uint256 indexed runId, address indexed key);
    event MovePlayed(uint256 indexed runId, uint256 tick, Move move);
    event TickAdvanced(uint256 indexed runId, uint256 tick, uint256 playerState);
    event GemCollected(uint256 indexed runId, uint8 posX, uint8 posY, uint256 newScore);
    event EnemyDefeated(uint256 indexed runId, uint8 indexed enemyIdx, uint256 newScore);
    event RunEnded(uint256 indexed runId, address indexed player, uint256 payout, uint256 finalScore, bool won);
    event LevelSet(uint256 indexed levelId);
    event HouseFeesClaimed(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address usdc) Ownable(initialOwner) {
        USDC = IERC20(usdc);
    }

    // -------------------------------------------------------------------------
    // Player-facing functions
    // -------------------------------------------------------------------------

    /**
     * @notice Start a new run. Transfers USDC entry fee from caller.
     * @param bet     USDC amount (6 decimals). Must be > 0.
     * @param levelId Level to play. Must have been seeded via setLevel.
     */
    function startRun(uint256 bet, uint256 levelId) external nonReentrant whenNotPaused {
        require(bet > 0, "CDB: bet=0");
        // Level 0 is built-in (LEVEL_MAP). Other levels must be loaded via setLevel.
        require(
            levelId == 0 || levels[levelId].length == LEVEL_WIDTH * LEVEL_HEIGHT,
            "CDB: level not set"
        );

        USDC.safeTransferFrom(msg.sender, address(this), bet);

        uint256 runId = nextRunId++;
        runs[runId] = Run({
            player:      msg.sender,
            levelId:     levelId,
            bet:         bet,
            tick:        0,
            playerState: _buildInitialState(),
            active:      true,
            finalScore:  0
        });

        emit RunStarted(runId, msg.sender, bet, levelId);
    }

    /**
     * @notice Authorize an ephemeral session key for a run.
     *         The session key can then call submitMove without MetaMask prompts.
     *         Only the run's player may set this. Can be updated any time while active.
     * @param runId The run ID.
     * @param key   The ephemeral address (generated in-browser, private key in localStorage).
     */
    function authorizeSessionKey(uint256 runId, address key) external {
        Run storage run = runs[runId];
        require(run.active,               "CDB: inactive");
        require(run.player == msg.sender, "CDB: not your run");
        require(key != address(0),        "CDB: zero key");
        sessionKeys[runId] = key;
        emit SessionKeySet(runId, key);
    }

    /**
     * @notice Submit a move and advance the game tick.
     *         Callable by the run's player OR the authorized session key.
     * @param runId The run ID.
     * @param move  The move to apply.
     */
    function submitMove(uint256 runId, Move move) external nonReentrant whenNotPaused {
        Run storage run = runs[runId];
        require(run.active, "CDB: inactive");
        require(
            msg.sender == run.player || msg.sender == sessionKeys[runId],
            "CDB: unauthorized"
        );

        emit MovePlayed(runId, run.tick, move);
        _advanceTick(runId, move);
    }

    /**
     * @notice Submit a batch of moves in a single transaction.
     *         Processes each move in order, stopping early if the run ends.
     *         Designed for the hybrid local-physics model: the client plays
     *         locally at 60fps and flushes batches to the chain periodically.
     * @param runId The run ID.
     * @param moves Array of moves to apply in sequence. Max 32 per batch.
     */
    function submitMoveBatch(uint256 runId, Move[] calldata moves) external nonReentrant whenNotPaused {
        require(moves.length > 0 && moves.length <= 32, "CDB: bad batch size");
        Run storage run = runs[runId];
        require(run.active, "CDB: inactive");
        require(
            msg.sender == run.player || msg.sender == sessionKeys[runId],
            "CDB: unauthorized"
        );

        for (uint256 i = 0; i < moves.length; i++) {
            emit MovePlayed(runId, run.tick, moves[i]);
            _advanceTick(runId, moves[i]);
            // Stop processing if run ended (health=0 or all gems collected)
            if (!runs[runId].active) break;
        }
    }

    // -------------------------------------------------------------------------
    // Internal — tick logic
    // -------------------------------------------------------------------------

    /**
     * @dev  Core game tick. Order: apply move → gravity → clamp → collision → repack.
     *       Coordinate system: posY increases downward (0=top, 15=bottom).
     *       velY uses physics sign (positive=up). Apply as: posY_new = posY - velY.
     */
    function _advanceTick(uint256 runId, Move move) internal {
        Run storage run = runs[runId];
        uint256 state = run.playerState;

        // Unpack
        uint8  posX      = _getPosX(state);
        uint8  posY      = _getPosY(state);
        int8   velY      = _getVelY(state);
        uint8  health    = _getHealth(state);
        uint8  animFrame = _getAnimFrame(state);
        uint56 score     = _getScore(state);

        // --- Horizontal move ---
        if (move == Move.Left  && posX > 0)                           posX--;
        if (move == Move.Right && posX < uint8(LEVEL_WIDTH  - 1))    posX++;

        // --- Jump (only when grounded: velY == 0) ---
        if (move == Move.Jump && velY == 0) velY = JUMP_IMPULSE;

        // --- Gravity ---
        unchecked { velY--; }                                   // velY -= 1
        if (velY < TERMINAL_VELOCITY) velY = TERMINAL_VELOCITY; // clamp

        // --- Apply vertical velocity (physics→screen: posY -= velY) ---
        uint8 prevPosY = posY;
        int16 nextY    = int16(uint16(posY)) - int16(velY);
        if (nextY < 0)                             nextY = 0;
        if (nextY >= int16(uint16(LEVEL_HEIGHT)))  nextY = int16(uint16(LEVEL_HEIGHT - 1));

        // Sweep intermediate rows to prevent tunneling through platforms
        if (velY != 0) {
            int16 dir = velY < 0 ? int16(1) : int16(-1); // falling→+1, rising→-1
            int16 iy  = int16(uint16(prevPosY)) + dir;
            while ((dir > 0) ? iy <= nextY : iy >= nextY) {
                if (_getTile(runId, posX, uint8(uint16(iy))) == TILE_WALL) {
                    nextY = iy - dir; // stop just before wall
                    velY  = 0;
                    break;
                }
                iy += dir;
            }
        }
        posY = uint8(uint16(nextY));

        // --- Tile collision (destination effects: gem, spike, wall fallback) ---
        uint8 tile = _getTile(runId, posX, posY);

        if (tile == TILE_WALL) {
            posY = prevPosY; // revert vertical move into solid
            velY = 0;        // land / hit ceiling
        } else if (tile == TILE_GEM) {
            score += uint56(GEM_SCORE);
            _clearTile(runId, posX, posY);
            emit GemCollected(runId, posX, posY, uint256(score));
        } else if (tile == TILE_SPIKE) {
            if (health > 0) health--;
        } else if (tile == TILE_ENEMY) {
            // Static enemy tile — used by custom levels (not level 0 which uses dynamic patrol)
            if (move == Move.Punch || move == Move.Kick) {
                score += uint56(ENEMY_SCORE);
                _clearTile(runId, posX, posY);
            } else {
                if (health > 0) health--;
            }
        }

        // --- Enemy collision (dynamic patrol, level 0 only) ---
        // Enemy positions are computed from the tick BEFORE increment (run.tick).
        if (runs[runId].levelId == 0) {
            uint8 def = _defeated[runId];
            for (uint8 i = 0; i < ENEMY_COUNT; i++) {
                if ((def >> i) & 1 == 1) continue;                       // already defeated
                uint8 ePosX = _enemyPosX(i, run.tick);
                uint8 ePosY = i == 0 ? ENEMY_0_Y : ENEMY_1_Y;
                if (move == Move.Punch || move == Move.Kick) {
                    // Attack has ±1 tile reach (player can punch from adjacent tile)
                    uint8 dx = posX >= ePosX ? posX - ePosX : ePosX - posX;
                    if (dx <= 1 && posY == ePosY) {
                        _defeated[runId] = def | (uint8(1) << i);
                        score += uint56(ENEMY_SCORE);
                        emit EnemyDefeated(runId, i, uint256(score));
                        break;
                    }
                } else if (posX == ePosX && posY == ePosY) {
                    // Damage zone: exact tile only
                    if (health > 0) health--;
                    break;
                }
            }
        }

        // --- Attack animation ---
        if (move == Move.Punch || move == Move.Kick) {
            animFrame = (animFrame + 1) % 4;
        }

        // --- Repack and store ---
        state           = _buildState(posX, posY, velY, health, animFrame, score);
        run.playerState = state;
        run.tick++;

        emit TickAdvanced(runId, run.tick, state);

        // --- End conditions ---
        if (health == 0) { _endRun(runId, false); return; }

        // Win: all Magical D gems collected this run.
        {
            uint256 levelId_     = runs[runId].levelId;
            uint256 requiredGems = levelId_ == 0
                ? LEVEL_0_GEM_COUNT
                : levelGemCounts[levelId_];
            if (requiredGems > 0 && _gemsCleared(runId) == requiredGems) {
                _endRun(runId, true);
                return;
            }
        }
    }

    /**
     * @dev Resolve payouts. Won: score-based multiplier, 1 % house cut.
     *      Lost: full bet goes to house.
     */
    function _endRun(uint256 runId, bool won) internal {
        Run storage run = runs[runId];
        run.active     = false;
        run.finalScore = uint256(_getScore(run.playerState));

        uint256 payout;

        if (won) {
            // multiplier = 1 + (finalScore / 10_000); expressed in bps
            uint256 multiplierBps = BPS_DENOM + run.finalScore;
            uint256 gross         = (run.bet * multiplierBps) / BPS_DENOM;
            uint256 fee           = (gross * HOUSE_FEE_BPS)  / BPS_DENOM;
            payout                = gross - fee;
            houseFees            += fee;

            // Cap at available balance (treasury may not fully cover high multipliers yet)
            uint256 available = USDC.balanceOf(address(this)) - houseFees;
            if (payout > available) payout = available;

            USDC.safeTransfer(run.player, payout);
        } else {
            houseFees += run.bet;
        }

        emit RunEnded(runId, run.player, payout, run.finalScore, won);
    }

    // -------------------------------------------------------------------------
    // Tile helpers
    // -------------------------------------------------------------------------

    function _getTile(uint256 runId, uint8 x, uint8 y) internal view returns (uint8) {
        uint256 idx    = uint256(y) * LEVEL_WIDTH + uint256(x);
        if (_cleared[runId][idx]) return TILE_AIR;
        // Custom level data (set via setLevel) takes priority over the built-in constant.
        bytes storage lvl = levels[runs[runId].levelId];
        if (lvl.length == LEVEL_WIDTH * LEVEL_HEIGHT) return uint8(lvl[idx]);
        // Fall back to built-in constant map (level 0).
        if (runs[runId].levelId == 0) return getTile(x, y);
        return TILE_AIR;
    }

    function _clearTile(uint256 runId, uint8 x, uint8 y) internal {
        _cleared[runId][uint256(y) * LEVEL_WIDTH + uint256(x)] = true;
    }

    /**
     * @notice Read a tile from the built-in level-0 constant map.
     * @dev    Row-major: LEVEL_MAP_BYTES[y * LEVEL_WIDTH + x].
     *         Returns TILE_AIR for out-of-bounds coordinates.
     */
    function getTile(uint8 x, uint8 y) public pure returns (uint8) {
        if (x >= uint8(LEVEL_WIDTH) || y >= uint8(LEVEL_HEIGHT)) return TILE_AIR;
        return uint8(LEVEL_MAP_BYTES[uint256(y) * LEVEL_WIDTH + uint256(x)]);
    }

    /**
     * @dev Count gems cleared in this run (level 0 only).
     *      Four storage reads; called once per tick only on gem-collect path.
     */
    function _gemsCleared(uint256 runId) internal view returns (uint256 count) {
        if (_cleared[runId][GEM_IDX_0]) count++;
        if (_cleared[runId][GEM_IDX_1]) count++;
        if (_cleared[runId][GEM_IDX_2]) count++;
        if (_cleared[runId][GEM_IDX_3]) count++;
    }

    // -------------------------------------------------------------------------
    // Enemy helpers
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the X position of enemy `idx` at a given tick.
     *         Pure ping-pong patrol: moves one step every `speed` ticks,
     *         bouncing between patrolMin and patrolMax.
     * @dev    Deterministic — same (idx, tick) always yields same result.
     */
    function _enemyPosX(uint8 idx, uint256 tick) internal pure returns (uint8) {
        uint256 pMin;
        uint256 pMax;
        uint256 spd;
        if (idx == 0) {
            pMin = ENEMY_0_PATROL_MIN; pMax = ENEMY_0_PATROL_MAX; spd = ENEMY_0_SPEED;
        } else {
            pMin = ENEMY_1_PATROL_MIN; pMax = ENEMY_1_PATROL_MAX; spd = ENEMY_1_SPEED;
        }
        uint256 range  = pMax - pMin;
        uint256 phase  = (tick / spd) % (range * 2);
        uint256 offset = phase <= range ? phase : range * 2 - phase;
        return uint8(pMin + offset);
    }

    /**
     * @notice Returns the defeat bitmask for a run. Bit i = 1 means enemy i dead.
     * @dev    Used by the frontend to sync enemy state after batch confirmation.
     */
    function enemyDefeated(uint256 runId) external view returns (uint8) {
        return _defeated[runId];
    }

    // -------------------------------------------------------------------------
    // Bit-packing helpers
    // -------------------------------------------------------------------------

    /// @dev Spawn at (2, 14): two tiles above the ground row.
    function _buildInitialState() internal pure returns (uint256) {
        return _buildState(2, 14, 0, INITIAL_HEALTH, 0, 0);
    }

    function _buildState(
        uint8  posX,
        uint8  posY,
        int8   velY,
        uint8  health,
        uint8  animFrame,
        uint56 score
    ) internal pure returns (uint256) {
        return (uint256(posX)        << POS_X_SHIFT)
             | (uint256(posY)        << POS_Y_SHIFT)
             | (uint256(uint8(velY)) << VEL_Y_SHIFT)
             | (uint256(health)      << HEALTH_SHIFT)
             | (uint256(animFrame)   << ANIM_SHIFT)
             | uint256(score);
    }

    function _getPosX(uint256 s)      internal pure returns (uint8)  { return uint8(s  >> POS_X_SHIFT);  }
    function _getPosY(uint256 s)      internal pure returns (uint8)  { return uint8(s  >> POS_Y_SHIFT);  }
    function _getVelY(uint256 s)      internal pure returns (int8)   { return int8(uint8(s >> VEL_Y_SHIFT)); }
    function _getHealth(uint256 s)    internal pure returns (uint8)  { return uint8(s  >> HEALTH_SHIFT); }
    function _getAnimFrame(uint256 s) internal pure returns (uint8)  { return uint8(s  >> ANIM_SHIFT);   }
    function _getScore(uint256 s)     internal pure returns (uint56) { return uint56(s  & SCORE_MASK);   }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /**
     * @notice Load or replace a level. Only owner.
     * @param levelId  Arbitrary level identifier (must be > 0; level 0 is built-in).
     * @param tileData Exactly LEVEL_WIDTH * LEVEL_HEIGHT bytes of tile values (0-4).
     * @param gemCount Number of gems the player must collect to win. 0 = endless run.
     */
    function setLevel(uint256 levelId, bytes calldata tileData, uint256 gemCount) external onlyOwner {
        require(levelId > 0,                                              "CDB: cannot overwrite level 0");
        require(tileData.length == LEVEL_WIDTH * LEVEL_HEIGHT,            "CDB: wrong level size");
        levels[levelId]         = tileData;
        levelGemCounts[levelId] = gemCount;
        emit LevelSet(levelId);
    }

    /**
     * @notice Withdraw accumulated house fees to `to`. Only owner.
     */
    function claimHouseFees(address to) external onlyOwner nonReentrant {
        uint256 amount = houseFees;
        houseFees      = 0;
        USDC.safeTransfer(to, amount);
        emit HouseFeesClaimed(to, amount);
    }

    /// @notice Pause all game actions.
    function pause()   external onlyOwner { _pause();   }

    /// @notice Unpause.
    function unpause() external onlyOwner { _unpause(); }

}
