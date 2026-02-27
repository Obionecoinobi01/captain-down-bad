// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaptainDownBad} from "../src/CaptainDownBad.sol";

/**
 * @dev Test harness that exposes internal functions for coverage.
 *      Never deploy this contract to production.
 */
contract CaptainDownBadHarness is CaptainDownBad {
    constructor(address initialOwner) CaptainDownBad(initialOwner) {}

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
}
