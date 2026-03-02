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
 *   USDC_ADDRESS           — USDC token address for the target chain
 *                            Base Sepolia : 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 *                            Base Mainnet : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
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
        address usdc        = vm.envAddress("USDC_ADDRESS");

        console.log("Deployer :", deployer);
        console.log("Owner    :", owner);
        console.log("USDC     :", usdc);
        console.log("Chain    :", block.chainid);

        vm.startBroadcast(deployerKey);

        CaptainDownBad game = new CaptainDownBad(owner, usdc);

        vm.stopBroadcast();

        console.log("CaptainDownBad deployed at:", address(game));
    }
}
