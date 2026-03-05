// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaptainDownBad} from "../src/CaptainDownBad.sol";

/**
 * @dev Test harness that exposes internal functions for coverage.
 *      Never deploy this contract to production.
 */
contract CaptainDownBadHarness is CaptainDownBad {
    constructor(address initialOwner, address usdc) CaptainDownBad(initialOwner, usdc) {}

    /// @dev Directly invoke _endRun with either outcome for coverage of the won=true path.
    function exposed_endRun(uint256 runId, bool won) external {
        _endRun(runId, won);
    }

    /// @dev Overwrite the score field in a run's packed playerState.
    ///      Used to simulate high-score scenarios without 10,000+ game ticks.
    function exposed_setScore(uint256 runId, uint56 score) external {
        runs[runId].playerState =
            (runs[runId].playerState & ~uint256(type(uint56).max)) | uint256(score);
    }

    /// @dev Mark a tile as cleared in the per-run cleared mapping.
    ///      Used in tests to simulate gem/enemy collection without navigating to the tile.
    function exposed_clearTileByXY(uint256 runId, uint8 x, uint8 y) external {
        _clearTile(runId, x, y);
    }

    /// @dev Expose the internal patrol function for direct unit testing.
    function exposed_enemyPosX(uint8 idx, uint256 tick) external pure returns (uint8) {
        return _enemyPosX(idx, tick);
    }

    /// @dev Teleport the player to (posX, posY) without touching velY or other fields.
    ///      Used to position the player next to a patrol enemy at a known tick.
    function exposed_setPlayerXY(uint256 runId, uint8 posX, uint8 posY) external {
        uint256 s = runs[runId].playerState;
        s = (s & ~(uint256(0xff) << 248)) | (uint256(posX) << 248);
        s = (s & ~(uint256(0xff) << 240)) | (uint256(posY) << 240);
        runs[runId].playerState = s;
    }

    /// @dev Advance the run's tick counter directly (no physics applied).
    ///      Lets tests assert enemy positions at arbitrary ticks.
    function exposed_setTick(uint256 runId, uint256 tick) external {
        runs[runId].tick = tick;
    }
}
