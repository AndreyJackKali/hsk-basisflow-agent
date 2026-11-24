// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IPool} from "./AgentVault.sol";

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title HSKSwapV3Adapter — Connects AgentVault to live HSKSwap V3 pools on HashKey Chain (Mainnet 177)
/// @notice Verified Mainnet 177 addresses:
///         - SwapRouter02: 0x1f3858C46F8F6fE76260b8208995D228C5cddc64
///         - WHSK (18 dec): 0xB210D2120d57b758EE163cFfb43e73728c471Cf1
///         - USDT (6 dec):  0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029
///         - WHSK/USDT 0.05% pool: 0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A
///         - WHSK/USDT 0.30% pool: 0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62
contract HSKSwapV3Adapter is IPool {
    ISwapRouter02 public immutable router;
    IUniswapV3Pool public immutable v3Pool;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    error InvalidToken();

    constructor(ISwapRouter02 _router, IUniswapV3Pool _v3Pool) {
        router = _router;
        v3Pool = _v3Pool;
        token0 = _v3Pool.token0();
        token1 = _v3Pool.token1();
        fee = _v3Pool.fee();
    }

    /// @notice Spot quote derived from Uniswap V3 sqrtPriceX96 net of pool fee (ppm).
    ///         Computes without intermediate overflow across 18-dec WHSK and 6-dec USDT.
    function quoteFromSqrtPrice(
        uint160 sqrtPriceX96,
        address tokenIn,
        uint256 amountIn
    ) public view returns (uint256 out) {
        if (tokenIn != token0 && tokenIn != token1) revert InvalidToken();
        uint256 amtNet = (amountIn * (1_000_000 - uint256(fee))) / 1_000_000;
        uint256 p = uint256(sqrtPriceX96);
        if (tokenIn == token0) {
            // token0 -> token1: out = amtNet * (sqrtPriceX96^2) / 2^192
            // Split into two shifts of 96 bits to prevent overflow.
            uint256 step1 = (amtNet * p) >> 96;
            out = (step1 * p) >> 96;
        } else {
            // token1 -> token0: out = amtNet * 2^192 / (sqrtPriceX96^2)
            // Shift 96 bits at a time to retain full precision without uint256 overflow.
            uint256 step1 = (amtNet << 96) / p;
            out = (step1 << 96) / p;
        }
    }

    function quote(address tokenIn, uint256 amountIn) external view override returns (uint256) {
        (uint160 sqrtPriceX96, , , , , , ) = v3Pool.slot0();
        return quoteFromSqrtPrice(sqrtPriceX96, tokenIn, amountIn);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external override returns (uint256 out) {
        if (tokenIn != token0 && tokenIn != token1) revert InvalidToken();
        address tokenOut = tokenIn == token0 ? token1 : token0;
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "tf");
        IERC20(tokenIn).approve(address(router), amountIn);
        out = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: to,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).approve(address(router), 0);
    }
}
