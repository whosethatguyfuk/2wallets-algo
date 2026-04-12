/**
 * rules.js — THE SINGLE SOURCE OF TRUTH
 *
 * Zero logic. Zero conditions. Constants only.
 * Every number the algo uses lives here and nowhere else.
 * To change a rule, change it here. One place. Always.
 */

// ── Discovery ────────────────────────────────────────────────────
export const UNLOCK_MC_USD        = 8_000;    // token must have crossed $8K MC to be eligible for arming
export const ENTRY_MC_MIN         = 4_000;    // pump.fun floors are ~$4.2K — 1.5x pump + momentum are the real filters
export const ENTRY_MC_MAX         = 50_000;   // never enter above $50K
export const MAX_POOL_SOL         = 70;       // skip tokens with >70 SOL in bonding curve (too big)

// ── Token quality (new pairs only) ───────────────────────────────
export const QUALITY_MIN_BUYERS   = 5;        // 5+ unique buyers required (our observation window is short)
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
// Fire on the FIRST qualifying buy — do NOT wait for momentum cluster.
// We want to be the first bid after the catalyst, not the exit liquidity.
export const CATALYST_MIN_SOL     = 0.15;    // minimum SOL buy to trigger entry
export const ARM_TIMEOUT_SECS     = 120;     // disarm if no catalyst in 120s

// ── Execution ────────────────────────────────────────────────────
export const POSITION_SOL         = Number(process.env.POSITION_SOL) || 0.2;
export const MAX_CONCURRENT       = 3;       // max simultaneous open positions

// ── Hold ─────────────────────────────────────────────────────────
// Pure order-flow strategy — NO time-based holds.
// Our bid tests the price level. The order book tells us if it holds.
// Sells on top = level rejected = exit immediately. No hold timers.
export const MIN_HOLD_SECS        = 0;       // no minimum hold — order flow decides instantly

// ── Exit thresholds ──────────────────────────────────────────────
// PRIMARY exit: sell appears on top of our position = level is weak = out NOW
export const SELLER_EXIT_SOL      = 0.15;    // sell ≥ 0.15 SOL on top of us = exit immediately
// SAFETY NET: price bleeds without big sells (should be rare at confirmed floor)
export const STOP_LOSS_PCT        = 4;       // hard stop -4% (floor test should bounce, not bleed)
// PROFIT: trail very early, let winners run, seller exit handles the rest
export const TAKE_PROFIT_PCT      = 20;      // flat TP fallback only
export const TRAIL_ACTIVATE_PCT   = 3;       // trail from +3% gain
export const TRAIL_KEEP_PCT       = 0.60;    // keep 60% of peak gain
export const MAX_HOLD_SECS        = 180;     // 3 min hard cap — zombie prevention only

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
