// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentVault, IERC20, IPool} from "../src/AgentVault.sol";
import {TestToken, MockPool} from "../src/MockPool.sol";
import {HSKSwapV3Adapter, IUniswapV3Pool, ISwapRouter02} from "../src/HSKSwapV3Adapter.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function envUint(string calldata key) external returns (uint256);
    function envOr(string calldata key, address defaultValue) external returns (address);
}

/// @notice 1-command deployment script for HashKey Chain Testnet (133) or local Anvil.
/// Usage:
///   PRIVATE_KEY=0x... AGENT_ADDRESS=0x... forge script script/Deploy.s.sol:DeployTestnet \
///     --rpc-url https://testnet.hsk.xyz --broadcast
contract DeployTestnet {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run()
        external
        returns (TestToken usdt, TestToken whsk, MockPool pool, AgentVault vault)
    {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address agentAddr = vm.envOr("AGENT_ADDRESS", address(0));

        vm.startBroadcast(pk);

        // Mirror HashKey Mainnet decimals: USDT = 6, WHSK = 18
        usdt = new TestToken("Test USDT", "tUSDT", 6);
        whsk = new TestToken("Test Wrapped HSK", "tWHSK", 18);
        pool = new MockPool(usdt, whsk);

        // Seed deep liquidity at $0.1000 USDT/WHSK (50,000 USDT / 500,000 WHSK)
        usdt.mint(deployer, 60_000e6);
        whsk.mint(deployer, 500_000e18);
        usdt.approve(address(pool), 50_000e6);
        whsk.approve(address(pool), 500_000e18);
        pool.addLiquidity(50_000e6, 500_000e18);

        vault = new AgentVault(IERC20(address(usdt)), IERC20(address(whsk)), IPool(address(pool)));
        usdt.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6);
        if (agentAddr != address(0)) {
            vault.setAgent(agentAddr);
        }
        // Default institutional risk profile: $1,000 max trade, 60% max exposure, 1% max slip,
        // 30s cooldown, 40 trades/day, $500 daily loss cap, $9,200 hard stop-loss.
        vault.setLimits(1_000e6, 6_000, 100, 30, 40, 500e6, 9_200e6);

        vm.stopBroadcast();
    }
}

/// @notice Production deployment for HashKey Chain Mainnet (chainId 177) wired to live HSKSwap V3.
contract DeployMainnet {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant HSKSWAP_ROUTER = 0x1f3858C46F8F6fE76260b8208995D228C5cddc64;
    address constant WHSK_MAINNET = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address constant USDT_MAINNET = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address constant WHSK_USDT_POOL_500 = 0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A;

    function run() external returns (HSKSwapV3Adapter adapter, AgentVault vault) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address agentAddr = vm.envOr("AGENT_ADDRESS", address(0));

        vm.startBroadcast(pk);
        adapter = new HSKSwapV3Adapter(ISwapRouter02(HSKSWAP_ROUTER), IUniswapV3Pool(WHSK_USDT_POOL_500));
        vault = new AgentVault(IERC20(USDT_MAINNET), IERC20(WHSK_MAINNET), IPool(address(adapter)));
        if (agentAddr != address(0)) {
            vault.setAgent(agentAddr);
        }
        vault.setLimits(500e6, 5_000, 100, 60, 24, 250e6, 9_200e6);
        vm.stopBroadcast();
    }
}
