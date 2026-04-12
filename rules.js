/**
 * rules.js — THE SINGLE SOURCE OF TRUTH
 *
 * Zero logic. Zero conditions. Constants only.
 * Every number the algo uses lives here and nowhere else.
 * To change a rule, change it here. One place. Always.
 */

// ── Discovery ────────────────────────────────────────────────────
export const UNLOCK_MC_USD        = 8_000;    // token must have crossed $8K MC to be eligible for arming
export const ENTRY_MC_MIN         = 3_500;    // never enter below $3.5K (floor zone for pump.fun tokens)
export const ENTRY_MC_MAX         = 50_000;   // never enter above $50K
export const MAX_POOL_SOL         = 70;       // skip tokens with >70 SOL in bonding curve (too big)

// ── Token quality (new pairs only) ───────────────────────────────
export const QUALITY_MIN_BUYERS   = 10;       // 10+ unique buyers required (lowered for new tokens)
export const QUALITY_MAX_BUY_SOL  = 1.6;     // no single buy >1.6 SOL while MC <$5K (whale filter)
export const QUALITY_MC_THRESHOLD = 5_000;   // above this MC, large buys are fine
export const BUNDLE_TXN_THRESHOLD = 6;       // >=6 txns in same second = bundled, skip
export const BUNDLE_WINDOW_MS     = 1_500;   // bundle detection window

// ── History requirement ──────────────────────────────────────────
// Token MUST have full history loaded before ANY gate can pass.
// No history = WATCHING state forever. No exceptions.
export const HISTORY_MIN_TRADES   = 10;      // minimum on-chain trades needed to establish floor

// ── Floor detection ──────────────────────────────────────────────
// Floor = session low. Not any bounce. The lowest confirmed price seen.
// We only arm when current price is within ARM_ZONE_PCT of that floor.
export const FLOOR_ARM_ZONE_PCT   = 0.08;    // arm when within 8% above session low
export const FLOOR_MIN_TOUCHES    = 2;       // floor must have been tested 2+ times to be confirmed
export const FLOOR_TOUCH_PCT      = 0.05;    // ±5% = "touching the same level"

// ── Arm → Catalyst ───────────────────────────────────────────────
export const CATALYST_MIN_SOL     = 0.10;    // minimum SOL buy to confirm catalyst (pump.fun typical range 0.1-0.5)
export const CATALYST_MAX_SPIKE   = 0.05;    // if catalyst spiked MC >5% from pre-catalyst, skip (entering high)
export const ARM_TIMEOUT_SECS     = 120;     // disarm if no catalyst in 120s

// ── Execution ────────────────────────────────────────────────────
export const POSITION_SOL         = Number(process.env.POSITION_SOL) || 0.2;
export const MAX_CONCURRENT       = 3;       // max simultaneous open positions

// ── Hold — the most important rule ──────────────────────────────
// Wallet-A holds winners 217s avg, 92s median.
// We will NOT exit before MIN_HOLD_SECS under any circumstances.
// This is enforced by setTimeout, not a soft check.
export const MIN_HOLD_SECS        = 30;      // absolute minimum — nothing fires before this
export const SELLER_EXIT_MIN_HOLD = 15;      // SELLER_EXIT gets a slightly shorter gate (big sell = real signal)

// ── Exit thresholds ──────────────────────────────────────────────
export const SELLER_EXIT_SOL      = 0.30;    // any sell ≥ 0.30 SOL on top of us = exit
export const STOP_LOSS_PCT        = 5;       // hard stop at -5% (always instant, no hold gate)
export const TAKE_PROFIT_PCT      = 15;      // base TP (dynamic based on conviction)
export const TRAIL_ACTIVATE_PCT   = 7;       // start trailing after +7% gain
export const TRAIL_KEEP_PCT       = 0.55;    // keep 55% of peak gain on trail
export const MAX_HOLD_SECS        = 300;     // 5 min hard max — no zombie trades
export const CONVICTION_HOLD_SECS = 60;      // weak conviction exit needs 60s minimum
export const CONVICTION_SELL_RATIO= 1.5;     // sells must be 1.5x buys to trigger conviction exit

// ── Re-entry rules ───────────────────────────────────────────────
// NEVER re-enter a token above its last exit price.
// If price is higher than where we sold, the move already happened — we missed it.
export const REENTRY_MAX_ABOVE_EXIT = 0.02;  // can re-enter up to 2% above last exit (slippage tolerance)
export const REENTRY_COOLDOWN_SECS  = 60;   // minimum seconds before any re-entry
export const MAX_TRADES_PER_TOKEN   = 3;    // after 3 trades on same token, blacklist for session

// ── Mayhem / bundle blacklist ─────────────────────────────────────
export const MAYHEM_AGENT_WALLET  = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s";

// ── Fees ─────────────────────────────────────────────────────────
export const TRADE_FEE_PCT        = 0.01;   // ~1% round trip

// ── Token states (the state machine) ─────────────────────────────
// Tokens move through these states in ORDER. No skipping.
export const STATE = Object.freeze({
  WATCHING:        'WATCHING',        // discovered, waiting for history
  INDEXED:         'INDEXED',         // history loaded, gates can now run
  FLOORED:         'FLOORED',         // floor confirmed, waiting for price to reach floor zone
  ARMED:           'ARMED',           // price is at floor zone, laser stream active, waiting for catalyst
  BUYING:          'BUYING',          // buy tx submitted, waiting for confirmation
  HOLDING:         'HOLDING',         // in trade, exit locked until MIN_HOLD_SECS
  EXIT_UNLOCKED:   'EXIT_UNLOCKED',   // hold timer expired, exit logic active
  CLOSED:          'CLOSED',          // trade closed, in cooldown
  BLACKLISTED:     'BLACKLISTED',     // too many trades, skip for session
});
