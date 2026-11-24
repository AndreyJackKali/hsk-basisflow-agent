// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentVault, IERC20, IPool} from "../src/AgentVault.sol";
import {TestToken, MockPool} from "../src/MockPool.sol";
import {HSKSwapV3Adapter, IUniswapV3Pool, ISwapRouter02} from "../src/HSKSwapV3Adapter.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
}

contract MockV3Pool {
    address public token0;
    address public token1;
    uint24 public fee;
    uint160 public sqrtPriceX96;

    constructor(address _t0, address _t1, uint24 _fee, uint160 _sqrtPriceX96) {
        token0 = _t0;
        token1 = _t1;
        fee = _fee;
        sqrtPriceX96 = _sqrtPriceX96;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, -299350, 0, 1, 1, 0, true);
    }
}

/// @notice Dependency-free Foundry test suite (runs offline with zero external libraries).
contract AgentVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    TestToken usdt;
    TestToken whsk;
    MockPool pool;
    AgentVault vault;

    address constant AGENT = address(0xA6E7);
    address constant LP = address(0x1111);
    address constant KEEPER = address(0xBEEF);

    function setUp() public {
        vm.warp(1_764_000_000); // Realistic timestamp (Nov 2025+)

        // Match real HashKey Chain Mainnet decimals: USDT = 6, WHSK = 18
        usdt = new TestToken("Test USDT", "tUSDT", 6);
        whsk = new TestToken("Test Wrapped HSK", "tWHSK", 18);
        pool = new MockPool(usdt, whsk);

        // Seed 100,000 tUSDT / 1,000,000 tWHSK => $0.1000 USDT per WHSK (matches live HSKSwap Mainnet!)
        usdt.mint(LP, 100_000e6);
        whsk.mint(LP, 1_000_000e18);
        vm.prank(LP);
        usdt.approve(address(pool), type(uint256).max);
        vm.prank(LP);
        whsk.approve(address(pool), type(uint256).max);
        vm.prank(LP);
        pool.addLiquidity(100_000e6, 1_000_000e18);

        vault = new AgentVault(IERC20(address(usdt)), IERC20(address(whsk)), IPool(address(pool)));
        usdt.mint(address(this), 10_000e6);
        usdt.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6);
        vault.setAgent(AGENT);
        // maxTrade=1,000 USDT, maxPos=60%, maxSlip=1%, cooldown=30s, maxDailyTrades=5, dailyLossCap=500 USDT, stopLoss=9,200 USDT
        vault.setLimits(1_000e6, 6_000, 100, 30, 5, 500e6, 9_200e6);
    }

    function test_AgentBuyAndSellRoundTrip() public {
        bytes32 sig1 = keccak256('{"pair":"WHSK/USDT","side":"BUY","spreadBps":142}');
        vm.prank(AGENT);
        uint256 whskOut = vault.trade(true, 500e6, sig1);
        require(whskOut > 4_900e18 && whsk.balanceOf(address(vault)) == whskOut, "buy fill");
        require(vault.tradeCount() == 1 && vault.dailyTradeCount() == 1, "counts");

        // Verify stored audit record
        (uint256 id, bytes32 sh, bool buyBase, uint256 amtIn, uint256 amtOut, uint256 eqAfter, uint64 ts) = vault.trades(1);
        require(id == 1 && sh == sig1 && buyBase && amtIn == 500e6 && amtOut == whskOut && eqAfter > 9_900e6 && ts > 0, "record");

        // Advance past cooldown and sell half back
        vm.warp(block.timestamp + 31);
        vm.prank(AGENT);
        uint256 usdtOut = vault.trade(false, whskOut / 2, keccak256("sell-1"));
        require(usdtOut > 240e6, "sell fill");
        require(vault.tradeCount() == 2, "count 2");
    }

    function test_RevertNonAgent() public {
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.trade(true, 100e6, bytes32(0));
    }

    function test_RevertZeroAmount() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.trade(true, 0, bytes32(0));
    }

    function test_RevertTradeTooLarge() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.TradeTooLarge.selector);
        vault.trade(true, 1_001e6, bytes32(0));
    }

    function test_RevertPositionLimitExceeded() public {
        // Set maxPositionBps to 15% (1500 bps), maxTrade to 2000 USDT
        vault.setLimits(2_000e6, 1_500, 100, 1, 10, 500e6, 9_000e6);
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.PositionLimitExceeded.selector);
        vault.trade(true, 1_800e6, keccak256("oversized-pos"));
    }

    function test_RevertCooldownActive() public {
        vm.prank(AGENT);
        vault.trade(true, 200e6, keccak256("t1"));

        vm.warp(block.timestamp + 15); // < 30s cooldown
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.CooldownActive.selector);
        vault.trade(true, 200e6, keccak256("t2"));

        vm.warp(block.timestamp + 15); // == 30s cooldown -> succeeds
        vm.prank(AGENT);
        vault.trade(true, 200e6, keccak256("t2-ok"));
        require(vault.tradeCount() == 2, "cooldown passed");
    }

    function test_RevertDailyTradeLimitAndRollover() public {
        // maxDailyTrades = 5
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(block.timestamp + 60);
            vm.prank(AGENT);
            vault.trade(true, 100e6, keccak256(abi.encodePacked("t", i)));
        }
        vm.warp(block.timestamp + 60);
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.DailyTradeLimit.selector);
        vault.trade(true, 100e6, keccak256("t6"));

        // Roll over to next UTC day -> counter resets
        vm.warp(block.timestamp + 1 days);
        vm.prank(AGENT);
        vault.trade(true, 100e6, keccak256("next-day"));
        require(vault.dailyTradeCount() == 1 && vault.tradeCount() == 6, "day rollover");
    }

    function test_PauseBlocksAgent() public {
        vault.setPaused(true);
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.IsPaused.selector);
        vault.trade(true, 100e6, bytes32(0));
    }

    function test_RevokeBlocksAgent() public {
        vault.revokeAgent();
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.trade(true, 100e6, bytes32(0));
    }

    function test_DailyLossCapReverts() public {
        // Agent buys 1,000 USDT of WHSK
        vm.prank(AGENT);
        vault.trade(true, 1_000e6, keccak256("entry"));

        // Market drops ~60% (LP dumps 1.5M WHSK into pool) -> equity falls > 500 USDT daily loss cap
        whsk.mint(LP, 1_500_000e18);
        vm.prank(LP);
        pool.swap(address(whsk), 1_500_000e18, 0, LP);

        vm.warp(block.timestamp + 60);
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.DailyLossCap.selector);
        vault.trade(true, 50e6, keccak256("should-revert"));
    }

    function test_StopLossAutoPausesOnTrade() public {
        vm.prank(AGENT);
        vault.trade(true, 1_000e6, keccak256("buy"));

        // Crash WHSK price by dumping into pool
        whsk.mint(LP, 2_000_000e18);
        vm.prank(LP);
        pool.swap(address(whsk), 2_000_000e18, 0, LP);

        // Widen daily loss cap so trade executes, tight stop-loss at 9,800 USDT triggers auto-pause
        vault.setLimits(1_000e6, 6_000, 100, 1, 10, 5_000e6, 9_800e6);
        vm.warp(block.timestamp + 5);
        vm.prank(AGENT);
        vault.trade(true, 10e6, keccak256("probe"));
        require(vault.paused(), "stop-loss did not auto-pause");
    }

    function test_PermissionlessStopLossKeeperTrigger() public {
        vm.prank(AGENT);
        vault.trade(true, 1_000e6, keccak256("buy"));

        // Before crash, triggerStopLoss must revert
        vm.prank(KEEPER);
        vm.expectRevert(AgentVault.StopLossNotBreached.selector);
        vault.triggerStopLoss();

        // Crash WHSK price so equity < 9,200 USDT
        whsk.mint(LP, 4_000_000e18);
        vm.prank(LP);
        pool.swap(address(whsk), 4_000_000e18, 0, LP);
        vault.setLimits(1_000e6, 6_000, 100, 30, 5, 500e6, 9_600e6);

        // Anyone (keeper) can immediately freeze vault when equity < stopLossEquity
        vm.prank(KEEPER);
        vault.triggerStopLoss();
        require(vault.paused(), "keeper pause failed");
    }

    function test_EmergencyUnwindAndWithdrawNonCustodial() public {
        vm.prank(AGENT);
        vault.trade(true, 1_000e6, keccak256("buy"));
        require(whsk.balanceOf(address(vault)) > 0, "has base");

        // Agent CANNOT withdraw or unwind
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdrawAll();

        vm.prank(AGENT);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.emergencyUnwind(0);

        // Owner unwinds all WHSK -> USDT (also pauses vault) and withdraws 100%
        uint256 qOut = vault.emergencyUnwind(900e6);
        require(qOut > 950e6 && vault.paused() && whsk.balanceOf(address(vault)) == 0, "unwound");

        (uint256 withdrawnQ, uint256 withdrawnB) = vault.withdrawAll();
        require(withdrawnQ > 9_950e6 && withdrawnB == 0, "withdrawn");
        require(usdt.balanceOf(address(vault)) == 0, "empty vault");
    }

    function test_OnlyOwnerLimitsAndValidation() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setLimits(1, 5000, 100, 10, 5, 100, 100);

        // Slippage > 10% (1000 bps) rejected
        vm.expectRevert(AgentVault.InvalidLimit.selector);
        vault.setLimits(1_000e6, 5_000, 1_001, 10, 5, 100e6, 9_000e6);

        // maxPositionBps == 0 rejected
        vm.expectRevert(AgentVault.InvalidLimit.selector);
        vault.setLimits(1_000e6, 0, 100, 10, 5, 100e6, 9_000e6);
    }

    function test_AllowanceResetAfterTrade() public {
        vm.prank(AGENT);
        vault.trade(true, 400e6, keccak256("sig"));
        require(usdt.allowance(address(vault), address(pool)) == 0, "leftover allowance");
    }

    function test_HSKSwapV3AdapterQuoteMatchesLiveMainnetSlot0() public {
        // Actual live HashKey Chain Mainnet (177) HSKSwap V3 WHSK/USDT 0.05% pool state
        // Block #30,587,839: sqrtPriceX96 = 25055738251564958613595 (~$0.100013 USDT per WHSK)
        MockV3Pool liveSnap = new MockV3Pool(address(whsk), address(usdt), 500, 25055738251564958613595);
        HSKSwapV3Adapter adapter = new HSKSwapV3Adapter(ISwapRouter02(address(0x1f3858C46F8F6fE76260b8208995D228C5cddc64)), IUniswapV3Pool(address(liveSnap)));

        // Quote selling 1,000 WHSK (1e21) -> should yield ~$99.96 USDT (99_962_xxx in 6-dec USDT after 0.05% fee)
        uint256 usdtOut = adapter.quote(address(whsk), 1_000e18);
        require(usdtOut >= 99_900_000 && usdtOut <= 100_100_000, "WHSK->USDT quote off");

        // Quote buying WHSK with 100 USDT (100e6) -> should yield ~999.37 WHSK (999e18)
        uint256 whskOut = adapter.quote(address(usdt), 100e6);
        require(whskOut >= 998e18 && whskOut <= 1_001e18, "USDT->WHSK quote off");
    }

    function testFuzz_ValidTradeSizesNeverBreachInvariants(uint256 rawAmt) public {
        // Bound between 1 USDT and maxTradeQuote (1,000 USDT)
        uint256 amt = (rawAmt % 1_000e6) + 1e6;
        vm.prank(AGENT);
        uint256 out = vault.trade(true, amt, keccak256(abi.encodePacked("fuzz", amt)));
        require(out > 0, "zero out");
        require(vault.positionBps() <= 6_000, "pos cap breached");
        require(vault.equity() >= 9_900e6, "unexpected equity loss");
    }
}
