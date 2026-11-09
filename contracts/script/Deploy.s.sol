// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ClearingHub} from "../src/ClearingHub.sol";
import {DepositFactory} from "../src/DepositFactory.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {TestnetStablecoin} from "../src/TestnetStablecoin.sol";

/// Deploys ClearingHub, DepositFactory and PaymentRouter deterministically and records them in deployments/<chainId>.json.
/// CREATE2 through the canonical deployer (0x4e59b44847b379578588920cA78FbF26c0B4956C, present on 31337, 133 and 177)
/// with a fixed salt gives each contract the same address on every chain, as long as the bytecode is identical.
/// A contract that already exists at its address is kept, with the block recorded for it in the deployments file,
/// so the gateway contracts can be added to a chain where the hub is already live.
/// On HashKey Chain Testnet (133) it also deploys Payminto Test USDC, because Circle's test USDC there has no public faucet.
/// Usage: forge script script/Deploy.s.sol --rpc-url hashkey --broadcast --account payminto-deployer
/// On HashKey Chain Testnet and Sepolia use script/deploy-create2.sh, which sends the same CREATE2 transactions
/// (Foundry 1.5 refuses chain 133 and under-estimates Sepolia's gas; docs/TESTNET.md section 3).
contract Deploy is Script {
    bytes32 internal constant SALT = keccak256("payminto.clearing.v1");
    bytes32 internal constant DEPOSITS_SALT = keccak256("payminto.deposits.v1");
    bytes32 internal constant ROUTER_SALT = keccak256("payminto.router.v1");
    bytes32 internal constant TEST_TOKEN_SALT = keccak256("payminto.testnet-usdc.v1");
    uint256 internal constant HASHKEY_TESTNET = 133;

    function run() external returns (ClearingHub hub, DepositFactory depositFactory, PaymentRouter router) {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory existing = vm.exists(path) ? vm.readFile(path) : "";

        address hubAt = vm.computeCreate2Address(SALT, keccak256(type(ClearingHub).creationCode));
        address factoryAt = vm.computeCreate2Address(DEPOSITS_SALT, keccak256(type(DepositFactory).creationCode));
        uint256 hubBlock = _recordedBlock(existing, ".clearingHub", ".blockNumber", hubAt);
        uint256 factoryBlock = _recordedBlock(existing, ".depositFactory", ".depositFactoryBlock", factoryAt);
        address routerAt = vm.computeCreate2Address(ROUTER_SALT, keccak256(type(PaymentRouter).creationCode));
        uint256 routerBlock = _recordedBlock(existing, ".paymentRouter", ".paymentRouterBlock", routerAt);
        bool withTestToken = block.chainid == HASHKEY_TESTNET;
        address tokenAt = vm.computeCreate2Address(TEST_TOKEN_SALT, keccak256(type(TestnetStablecoin).creationCode));

        vm.startBroadcast();
        if (hubAt.code.length == 0) {
            hub = new ClearingHub{salt: SALT}();
            hubBlock = block.number;
        } else {
            hub = ClearingHub(hubAt);
            console2.log("ClearingHub already deployed, keeping it");
        }
        if (factoryAt.code.length == 0) {
            depositFactory = new DepositFactory{salt: DEPOSITS_SALT}();
            factoryBlock = block.number;
        } else {
            depositFactory = DepositFactory(factoryAt);
            console2.log("DepositFactory already deployed, keeping it");
        }
        if (routerAt.code.length == 0) {
            router = new PaymentRouter{salt: ROUTER_SALT}();
            routerBlock = block.number;
        } else {
            router = PaymentRouter(routerAt);
            console2.log("PaymentRouter already deployed, keeping it");
        }
        if (withTestToken && tokenAt.code.length == 0) {
            require(address(new TestnetStablecoin{salt: TEST_TOKEN_SALT}()) == tokenAt, "unexpected CREATE2 address");
        }
        vm.stopBroadcast();
        require(
            address(hub) == hubAt && address(depositFactory) == factoryAt && address(router) == routerAt,
            "unexpected CREATE2 address"
        );

        string memory json = vm.serializeAddress("deployment", "clearingHub", address(hub));
        json = vm.serializeUint("deployment", "chainId", block.chainid);
        json = vm.serializeUint("deployment", "blockNumber", hubBlock);
        json = vm.serializeAddress("deployment", "depositFactory", address(depositFactory));
        json = vm.serializeAddress("deployment", "depositForwarderImplementation", depositFactory.implementation());
        json = vm.serializeUint("deployment", "depositFactoryBlock", factoryBlock);
        json = vm.serializeAddress("deployment", "paymentRouter", address(router));
        json = vm.serializeUint("deployment", "paymentRouterBlock", routerBlock);
        if (withTestToken) json = vm.serializeAddress("deployment", "token", tokenAt);
        // A fresh clone has no deployments/ directory content; make sure it exists before writing.
        vm.createDir("deployments", true);
        vm.writeJson(json, path);
        console2.log("ClearingHub", address(hub));
        console2.log("DepositFactory", address(depositFactory));
        console2.log("PaymentRouter", address(router));
        if (withTestToken) console2.log("TestnetStablecoin", tokenAt);
    }

    /// The block recorded for a contract that already has code at `at`. Refuses to guess when the file does not
    /// record it, because the node starts its log scans from that block.
    function _recordedBlock(string memory json, string memory addrKey, string memory blockKey, address at)
        internal
        view
        returns (uint256)
    {
        if (at.code.length == 0) return 0;
        require(
            bytes(json).length != 0 && vm.keyExistsJson(json, addrKey) && vm.keyExistsJson(json, blockKey)
                && vm.parseJsonAddress(json, addrKey) == at,
            string.concat(
                vm.toString(at), " already has code but the deployments file does not record it; restore the file"
            )
        );
        return vm.parseJsonUint(json, blockKey);
    }
}
