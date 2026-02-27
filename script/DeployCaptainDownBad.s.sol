// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CaptainDownBad}  from "../src/CaptainDownBad.sol";

/**
 * @dev Deploy CaptainDownBad to Base Sepolia and verify on Basescan.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — deployer wallet private key (0x-prefixed)
 *   OWNER_ADDRESS          — address that receives Ownable ownership (defaults to deployer)
 *   BASESCAN_API_KEY       — Basescan API key for --verify
 *
 * Run:
 *   forge script script/DeployCaptainDownBad.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 */
contract DeployCaptainDownBad is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address owner       = vm.envOr("OWNER_ADDRESS", deployer);

        console.log("Deployer :", deployer);
        console.log("Owner    :", owner);
        console.log("Chain    :", block.chainid);

        vm.startBroadcast(deployerKey);

        CaptainDownBad game = new CaptainDownBad(owner);

        vm.stopBroadcast();

        console.log("CaptainDownBad deployed at:", address(game));
    }
}
