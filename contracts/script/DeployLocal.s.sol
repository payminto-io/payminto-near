// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ClearingHub} from "../src/ClearingHub.sol";
import {DepositFactory} from "../src/DepositFactory.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// Local anvil only: deploys the hub, a mock USDC, the deposit factory and the payment router, and writes deployments/31337.json
/// (or DEPLOY_LOCAL_OUT, a path under deployments/, so parallel runs each read their own deployment).
/// The gateway contracts are deployed last so the hub and token keep the addresses they had before it existed.
contract DeployLocal is Script {
    function run() external {
        require(block.chainid == 31337, "DeployLocal is for anvil only");
        vm.startBroadcast();
        ClearingHub hub = new ClearingHub();
        MockStablecoin usdc = new MockStablecoin();
        DepositFactory depositFactory = new DepositFactory();
        PaymentRouter router = new PaymentRouter();
        vm.stopBroadcast();

        string memory json = vm.serializeAddress("deployment", "clearingHub", address(hub));
        json = vm.serializeAddress("deployment", "token", address(usdc));
        json = vm.serializeUint("deployment", "chainId", block.chainid);
        json = vm.serializeUint("deployment", "blockNumber", block.number);
        json = vm.serializeAddress("deployment", "depositFactory", address(depositFactory));
        json = vm.serializeAddress("deployment", "depositForwarderImplementation", depositFactory.implementation());
        json = vm.serializeUint("deployment", "depositFactoryBlock", block.number);
        json = vm.serializeAddress("deployment", "paymentRouter", address(router));
        json = vm.serializeUint("deployment", "paymentRouterBlock", block.number);
        string memory out = vm.envOr("DEPLOY_LOCAL_OUT", string("deployments/31337.json"));
        vm.createDir("deployments/local", true);
        vm.writeJson(json, out);
        console2.log("ClearingHub", address(hub));
        console2.log("MockStablecoin", address(usdc));
        console2.log("DepositFactory", address(depositFactory));
        console2.log("PaymentRouter", address(router));
    }
}
