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
export const FLOOR_ARM_ZONE_PCT   = 0.03;     // arm when within 3% above session low (surgical)
export const FLOOR_MIN_TOUCHES    = 2;        // floor must have been tested 2+ times
export const FLOOR_TOUCH_PCT      = 0.06;     // ±6% = "touching the same level"
export const ARM_MIN_ATH_MULT     = 1.3;      // lowered — let more tokens arm, classify QUICK vs HOLD at entry

// ── Arm → Entry ─────────────────────────────────────────────────
export const CATALYST_MIN_SOL     = 0;        // no catalyst — any buy at the floor triggers entry
export const ARM_TIMEOUT_SECS     = 120;      // disarm if no entry in 2 min

// ── Execution ───────────────────────────────────────────────────
export const POSITION_SOL         = Number(process.env.POSITION_SOL) || 0.2;
export const MAX_CONCURRENT       = 5;

// ══════════════════════════════════════════════════════════════════
// DUAL MODE: tokens classified at entry as QUICK or HOLD
// ══════════════════════════════════════════════════════════════════

// ── HOLD mode thresholds (strong established tokens) ─────────────
export const STRONG_MIN_FLOOR_TOUCHES = 4;    // floor tested 4+ times
export const STRONG_MIN_ATH_MULT      = 2.0;  // ATH must be ≥ 2x floor
export const STRONG_MIN_TICKS         = 50;   // 50+ ticks of data

// ── HOLD mode exits — DCA sell for high multiples ────────────────
export const DCA_TRANCHE_0_MULT   = 1.5;     // sell 20% at 1.5x entry
export const DCA_TRANCHE_1_MULT   = 2.0;     // sell 25% at 2x entry
export const DCA_TRANCHE_2_MULT   = 2.5;     // sell 25% at 2.5x entry
export const DCA_TRANCHE_3_MULT   = 3.0;     // sell 30% at 3x entry
export const DCA_TRANCHE_0_PCT    = 0.20;
export const DCA_TRANCHE_1_PCT    = 0.25;
export const DCA_TRANCHE_2_PCT    = 0.25;
export const DCA_TRANCHE_3_PCT    = 0.30;
export const HOLD_STOP_PCT        = 0.06;    // 6% stop from entry
export const HOLD_MAX_HOLD_SECS   = 2700;    // 45 min max

// ── QUICK mode exits — fast scalp, seller exit ───────────────────
export const QUICK_STOP_PCT       = 0.04;    // 4% stop from entry (tight)
export const QUICK_TP_PCT         = 0.15;    // 15% take profit (full exit)
export const QUICK_MAX_HOLD_SECS  = 180;     // 3 min max hold

// ── Bond cap (both modes) ────────────────────────────────────────
export const BOND_MC_SELL         = 55_000;

// ── Re-entry rules ──────────────────────────────────────────────
export const REENTRY_MAX_ABOVE_EXIT = 0.05;
export const REENTRY_COOLDOWN_SECS  = 60;     // faster re-entry
export const MAX_TRADES_PER_TOKEN   = 8;      // more trades allowed — quick scalps cycle fast

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
export const TRADE_FEE_PCT        = 0.01;     // ~1% per side on pump.fun

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
