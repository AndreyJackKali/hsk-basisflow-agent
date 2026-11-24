// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mintable ERC20 with configurable decimals (e.g. 6 for tUSDT, 18 for tWHSK
///         to mirror live HashKey Chain Mainnet token decimals).
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address t, uint256 v) external returns (bool) {
        _move(msg.sender, t, v);
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "allow");
            allowance[f][msg.sender] = a - v;
        }
        _move(f, t, v);
        return true;
    }

    function _move(address f, address t, uint256 v) internal {
        require(balanceOf[f] >= v, "bal");
        balanceOf[f] -= v;
        balanceOf[t] += v;
        emit Transfer(f, t, v);
    }
}

/// @notice Constant-product AMM (0.05% fee = 9995/10000, matching HSKSwap V3 500-fee tier)
///         used as the self-contained venue on HashKey Chain Testnet (chainId 133) and local Anvil.
contract MockPool {
    TestToken public immutable a; // quote (e.g. tUSDT, 6 dec)
    TestToken public immutable b; // base  (e.g. tWHSK, 18 dec)
    uint256 public ra;
    uint256 public rb;

    event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB);
    event Swap(address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed to);

    constructor(TestToken _a, TestToken _b) {
        a = _a;
        b = _b;
    }

    function addLiquidity(uint256 x, uint256 y) external {
        require(a.transferFrom(msg.sender, address(this), x), "tfa");
        require(b.transferFrom(msg.sender, address(this), y), "tfb");
        ra += x;
        rb += y;
        emit LiquidityAdded(msg.sender, x, y);
    }

    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        require(tokenIn == address(a) || tokenIn == address(b), "token");
        (uint256 rin, uint256 rout) = tokenIn == address(a) ? (ra, rb) : (rb, ra);
        if (rin == 0 || rout == 0 || amountIn == 0) return 0;
        uint256 inFee = amountIn * 9995;
        return (inFee * rout) / (rin * 10_000 + inFee);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        require(tokenIn == address(a) || tokenIn == address(b), "token");
        out = quote(tokenIn, amountIn);
        require(out >= minOut, "slippage");
        if (tokenIn == address(a)) {
            require(a.transferFrom(msg.sender, address(this), amountIn), "tfa");
            require(b.transfer(to, out), "tfb");
            ra += amountIn;
            rb -= out;
        } else {
            require(b.transferFrom(msg.sender, address(this), amountIn), "tfb");
            require(a.transfer(to, out), "tfa");
            rb += amountIn;
            ra -= out;
        }
        emit Swap(tokenIn, amountIn, out, to);
    }
}
