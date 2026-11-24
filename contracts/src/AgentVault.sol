// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function decimals() external view returns (uint8);
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address f, address t, uint256 v) external returns (bool);
    function approve(address s, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface IPool {
    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out);
    function quote(address tokenIn, uint256 amountIn) external view returns (uint256 out);
}

/// @title AgentVault — Non-Custodial, Risk-Bounded AI Trading Vault for HashKey Chain (HSK)
/// @notice The owner deposits quote collateral (USDT) and delegates trading execution to an AI
///         agent EOA strictly bounded by on-chain risk controls:
///         1) maxTradeQuote     — max quote notional per single trade
///         2) maxPositionBps    — max base-asset exposure as % of total vault equity (bps)
///         3) maxSlippageBps    — max slippage vs live executable venue quote (bps)
///         4) cooldownSecs      — min interval between consecutive agent trades
///         5) maxDailyTrades    — max trade count per UTC day
///         6) dailyLossCapQuote — max equity drawdown allowed within a single UTC day
///         7) stopLossEquity    — hard equity floor triggering automatic circuit-breaker pause
///         The agent can NEVER withdraw user funds. Every trade commits an auditable keccak256
///         `signalHash` of the off-chain AI signal payload on-chain.
contract AgentVault {
    struct RiskLimits {
        uint256 maxTradeQuote;
        uint16 maxPositionBps;
        uint16 maxSlippageBps;
        uint32 cooldownSecs;
        uint16 maxDailyTrades;
        uint256 dailyLossCapQuote;
        uint256 stopLossEquity;
    }

    struct TradeRecord {
        uint256 id;
        bytes32 signalHash;
        bool buyBase;
        uint256 amountIn;
        uint256 amountOut;
        uint256 equityAfter;
        uint64 timestamp;
    }

    address public immutable owner;
    IERC20 public immutable quote; // e.g. USDT (6 decimals on HSK Mainnet)
    IERC20 public immutable base;  // e.g. WHSK (18 decimals on HSK Mainnet)
    IPool public pool;

    address public agent;
    bool public paused;
    uint256 private _locked = 1;

    RiskLimits public limits;

    uint256 public dayStart;
    uint256 public dayStartEquity;
    uint16 public dailyTradeCount;
    uint64 public lastTradeAt;
    uint256 public tradeCount;
    uint256 public initialDeposited;

    mapping(uint256 => TradeRecord) public trades;

    event AgentSet(address indexed agent);
    event PoolSet(address indexed pool);
    event LimitsSet(
        uint256 maxTradeQuote,
        uint16 maxPositionBps,
        uint16 maxSlippageBps,
        uint32 cooldownSecs,
        uint16 maxDailyTrades,
        uint256 dailyLossCapQuote,
        uint256 stopLossEquity
    );
    event Deposited(address indexed owner, uint256 amount, uint256 newEquity);
    event Withdrawn(address indexed owner, uint256 quoteOut, uint256 baseOut);
    event EmergencyUnwound(uint256 baseSold, uint256 quoteReceived);
    event TradeExecuted(
        uint256 indexed id,
        bytes32 indexed signalHash,
        bool buyBase,
        uint256 amountIn,
        uint256 amountOut,
        uint256 equityAfter
    );
    event StopLossTriggered(uint256 equity, uint256 threshold, address indexed triggeredBy);
    event Paused(bool paused);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error ZeroAmount();
    error InvalidLimit();
    error TradeTooLarge();
    error PositionLimitExceeded();
    error CooldownActive();
    error DailyTradeLimit();
    error DailyLossCap();
    error StopLossNotBreached();
    error Reentrant();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IERC20 _quote, IERC20 _base, IPool _pool) {
        if (address(_quote) == address(0) || address(_base) == address(0) || address(_pool) == address(0)) {
            revert InvalidLimit();
        }
        owner = msg.sender;
        quote = _quote;
        base = _base;
        pool = _pool;
    }

    // ---------------- Owner Controls ----------------

    function setAgent(address a) external onlyOwner {
        agent = a;
        emit AgentSet(a);
    }

    function revokeAgent() external onlyOwner {
        agent = address(0);
        emit AgentSet(address(0));
    }

    function setPool(IPool _pool) external onlyOwner {
        if (address(_pool) == address(0)) revert InvalidLimit();
        pool = _pool;
        emit PoolSet(address(_pool));
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function setLimits(
        uint256 _maxTradeQuote,
        uint16 _maxPositionBps,
        uint16 _maxSlippageBps,
        uint32 _cooldownSecs,
        uint16 _maxDailyTrades,
        uint256 _dailyLossCapQuote,
        uint256 _stopLossEquity
    ) external onlyOwner {
        if (_maxSlippageBps > 1_000 || _maxPositionBps == 0 || _maxPositionBps > 10_000 || _maxDailyTrades == 0) {
            revert InvalidLimit();
        }
        limits = RiskLimits({
            maxTradeQuote: _maxTradeQuote,
            maxPositionBps: _maxPositionBps,
            maxSlippageBps: _maxSlippageBps,
            cooldownSecs: _cooldownSecs,
            maxDailyTrades: _maxDailyTrades,
            dailyLossCapQuote: _dailyLossCapQuote,
            stopLossEquity: _stopLossEquity
        });
        emit LimitsSet(
            _maxTradeQuote,
            _maxPositionBps,
            _maxSlippageBps,
            _cooldownSecs,
            _maxDailyTrades,
            _dailyLossCapQuote,
            _stopLossEquity
        );
    }

    function deposit(uint256 amt) external onlyOwner nonReentrant {
        if (amt == 0) revert ZeroAmount();
        if (!quote.transferFrom(msg.sender, address(this), amt)) revert TransferFailed();
        initialDeposited += amt;
        uint256 eq = equity();
        if (dayStart == 0) {
            dayStart = block.timestamp / 1 days;
            dayStartEquity = eq;
        } else {
            dayStartEquity += amt;
        }
        emit Deposited(msg.sender, amt, eq);
    }

    /// @notice Owner can always unwind base -> quote directly and pause the vault.
    function emergencyUnwind(uint256 minQuoteOut) external onlyOwner nonReentrant returns (uint256 out) {
        paused = true;
        emit Paused(true);
        uint256 b = base.balanceOf(address(this));
        if (b == 0) return 0;
        base.approve(address(pool), b);
        out = pool.swap(address(base), b, minQuoteOut, address(this));
        emit EmergencyUnwound(b, out);
    }

    /// @notice Non-custodial escape hatch: owner can withdraw all quote & base at any time.
    function withdrawAll() external onlyOwner nonReentrant returns (uint256 qBal, uint256 bBal) {
        qBal = quote.balanceOf(address(this));
        bBal = base.balanceOf(address(this));
        if (qBal > 0 && !quote.transfer(owner, qBal)) revert TransferFailed();
        if (bBal > 0 && !base.transfer(owner, bBal)) revert TransferFailed();
        emit Withdrawn(owner, qBal, bBal);
    }

    // ---------------- Views ----------------

    /// @notice Total vault equity marked in quote units using live executable venue quotes.
    function equity() public view returns (uint256 eq) {
        eq = quote.balanceOf(address(this));
        uint256 b = base.balanceOf(address(this));
        if (b > 0) eq += pool.quote(address(base), b);
    }

    /// @notice Current base-asset exposure in basis points of total equity.
    function positionBps() public view returns (uint256) {
        uint256 eq = equity();
        if (eq == 0) return 0;
        uint256 b = base.balanceOf(address(this));
        if (b == 0) return 0;
        return (pool.quote(address(base), b) * 10_000) / eq;
    }

    /// @notice Permissionless circuit-breaker check: if market drops below stopLossEquity while idle,
    ///         any keeper (or owner/agent) can freeze trading immediately.
    function triggerStopLoss() external {
        uint256 eq = equity();
        if (eq >= limits.stopLossEquity || paused) revert StopLossNotBreached();
        paused = true;
        emit StopLossTriggered(eq, limits.stopLossEquity, msg.sender);
        emit Paused(true);
    }

    // ---------------- Agent Execution ----------------

    /// @param buyBase true = buy base with quote (USDT -> WHSK), false = sell base for quote (WHSK -> USDT)
    /// @param amountIn exact input token amount
    /// @param signalHash keccak256 hash of canonical off-chain AI signal JSON for verifiable audit trail
    function trade(bool buyBase, uint256 amountIn, bytes32 signalHash) external nonReentrant returns (uint256 out) {
        if (msg.sender != agent || agent == address(0)) revert NotAgent();
        if (paused) revert IsPaused();
        if (amountIn == 0) revert ZeroAmount();

        _rollDay();

        if (lastTradeAt != 0 && block.timestamp < uint256(lastTradeAt) + uint256(limits.cooldownSecs)) {
            revert CooldownActive();
        }
        if (dailyTradeCount >= limits.maxDailyTrades) revert DailyTradeLimit();

        address tokenIn = buyBase ? address(quote) : address(base);
        uint256 notional = buyBase ? amountIn : pool.quote(address(base), amountIn);
        if (notional > limits.maxTradeQuote) revert TradeTooLarge();

        uint256 expected = pool.quote(tokenIn, amountIn);
        uint256 minOut = (expected * (10_000 - limits.maxSlippageBps)) / 10_000;

        IERC20(tokenIn).approve(address(pool), amountIn);
        out = pool.swap(tokenIn, amountIn, minOut, address(this));

        // Reset leftover allowance defensively
        IERC20(tokenIn).approve(address(pool), 0);

        uint256 eq = equity();

        // Enforce max base-asset exposure after buys
        if (buyBase && positionBps() > limits.maxPositionBps) {
            revert PositionLimitExceeded();
        }

        // Enforce daily loss cap unless we are below hard stop-loss (in which case allow exit/trigger pause)
        if (dayStartEquity > eq && (dayStartEquity - eq) > limits.dailyLossCapQuote) {
            revert DailyLossCap();
        }

        unchecked {
            tradeCount++;
            dailyTradeCount++;
        }
        lastTradeAt = uint64(block.timestamp);

        trades[tradeCount] = TradeRecord({
            id: tradeCount,
            signalHash: signalHash,
            buyBase: buyBase,
            amountIn: amountIn,
            amountOut: out,
            equityAfter: eq,
            timestamp: uint64(block.timestamp)
        });

        emit TradeExecuted(tradeCount, signalHash, buyBase, amountIn, out, eq);

        if (eq < limits.stopLossEquity) {
            paused = true;
            emit StopLossTriggered(eq, limits.stopLossEquity, msg.sender);
            emit Paused(true);
        }
    }

    function _rollDay() internal {
        uint256 d = block.timestamp / 1 days;
        if (d != dayStart) {
            dayStart = d;
            dayStartEquity = equity();
            dailyTradeCount = 0;
        }
    }
}
