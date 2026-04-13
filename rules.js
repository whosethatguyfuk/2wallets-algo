/**
 * rules.js — THE SINGLE SOURCE OF TRUTH
 *
 * Zero logic. Zero conditions. Constants only.
 * Every number the algo uses lives here and nowhere else.
 * To change a rule, change it here. One place. Always.
 */

// ── Discovery ────────────────────────────────────────────────────
export const ENTRY_MC_MIN         = 4_000;    // pump.fun floors are ~$4.2K
export const ENTRY_MC_MAX         = 50_000;   // never enter above $50K
export const MAX_POOL_SOL         = 120;      // skip tokens with >120 SOL in bonding curve

// ── Nursery ─────────────────────────────────────────────────────
export const NURSERY_MAX          = 600;      // max simultaneous nursery subscriptions
export const NURSERY_PURGE_MS     = 3 * 60_000; // purge dead tokens every 3 min
export const NURSERY_MIN_TRADERS  = 7;        // dead = < 7 unique traders after purge window
export const COLD_PROMOTE_MC      = 5_000;    // re-promote cold-watch token if MC crosses this

// ── Jito bundle detection (same-slot method) ────────────────────
export const JITO_SAME_SLOT_BUYS  = 5;        // 5+ buys in the create slot = bundle
export const JITO_SAME_SLOT_WALLETS = 3;      // from 3+ different wallets
export const JITO_ROUND2_MIN_ATH  = 10_000;   // bundled + ATH < $10K = blacklist (not worth round 2)
export const ROUND2_PUMP_MULT     = 2.0;      // round-2: sessionHigh must be > floor × 2.0 to arm

// ── Token quality ───────────────────────────────────────────────
export const QUALITY_MIN_BUYERS   = 5;        // 5+ unique buyers required (new tokens)
export const QUALITY_MIN_BUYERS_OLD = 3;      // 3+ unique buyers required (old/seeded tokens)
export const QUALITY_MAX_BUY_SOL  = 1.6;      // no single buy >1.6 SOL while MC <$5K (whale filter)
export const QUALITY_MC_THRESHOLD = 5_000;     // above this MC, large buys are fine

// ── History requirement ─────────────────────────────────────────
export const HISTORY_MIN_TRADES   = 10;       // minimum trades needed to establish floor

// ── Floor detection ─────────────────────────────────────────────
export const FLOOR_ARM_ZONE_PCT   = 0.15;     // arm when within 15% above session low
export const FLOOR_MIN_TOUCHES    = 3;        // floor must have been tested 3+ times
export const FLOOR_TOUCH_PCT      = 0.06;     // ±6% = "touching the same level"

// ── Arm → Catalyst ──────────────────────────────────────────────
export const CATALYST_MIN_SOL     = 0.20;     // minimum SOL buy to trigger entry
export const ARM_TIMEOUT_SECS     = 300;      // disarm if no catalyst in 5 min

// ── Execution ───────────────────────────────────────────────────
export const POSITION_SOL         = Number(process.env.POSITION_SOL) || 0.2;
export const MAX_CONCURRENT       = 3;

// ── Hold ────────────────────────────────────────────────────────
export const MIN_HOLD_SECS        = 0;        // no minimum hold — order flow decides

// ── Exit thresholds ─────────────────────────────────────────────
export const SELLER_EXIT_SOL      = 0.15;     // sell ≥ 0.15 SOL on top = exit
export const STOP_LOSS_PCT        = 4;        // hard stop -4%
export const TAKE_PROFIT_PCT      = 20;       // flat TP fallback
export const TRAIL_ACTIVATE_PCT   = 3;        // trail from +3% gain
export const TRAIL_KEEP_PCT       = 0.60;     // keep 60% of peak gain
export const MAX_HOLD_SECS        = 180;      // 3 min hard cap

// ── Re-entry rules ──────────────────────────────────────────────
export const REENTRY_MAX_ABOVE_EXIT = 0.02;
export const REENTRY_COOLDOWN_SECS  = 60;
export const MAX_TRADES_PER_TOKEN   = 3;

// ── Mayhem blacklist ────────────────────────────────────────────
export const MAYHEM_AGENT_WALLET  = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s";

// ── MC direction correction ─────────────────────────────────────
export const MC_DIRECTION_MIN_DELTA = 0.005;  // only override PP txType if MC moved >0.5%

// ── Persistence ─────────────────────────────────────────────────
export const PENDING_TIMEOUT_MS   = 30_000;   // cancel pending slippage buys/sells after 30s
export const SNAPSHOT_INTERVAL_MS = 60_000;   // save state every 60s
export const RESUB_BATCH_SIZE     = 50;       // re-subscribe in batches on restart
export const RESUB_BATCH_DELAY_MS = 500;      // delay between batches

// ── Fees ────────────────────────────────────────────────────────
export const TRADE_FEE_PCT        = 0.02;     // ~2% round trip (1% per side on pump.fun)

// ── Data bounds ─────────────────────────────────────────────────
export const MAX_SOL_PER_TICK     = 50;       // reject PP ticks with solAmount > 50 SOL
export const MAX_MC_CHANGE_PCT    = 0.50;     // reject ticks where MC moves >50% in one tick (unless first few)
export const MC_BONDING_CURVE_MAX = 120_000;  // max possible MC on bonding curve (pre-migration)

// ── Token states ────────────────────────────────────────────────
export const STATE = Object.freeze({
  WATCHING:        'WATCHING',
  INDEXED:         'INDEXED',
  FLOORED:         'FLOORED',
  ARMED:           'ARMED',
  BUYING:          'BUYING',
  HOLDING:         'HOLDING',
  EXIT_UNLOCKED:   'EXIT_UNLOCKED',
  CLOSED:          'CLOSED',
  BLACKLISTED:     'BLACKLISTED',
});
