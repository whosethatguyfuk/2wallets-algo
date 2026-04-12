/**
 * gates.js — PURE GATE FUNCTIONS
 *
 * Every gate returns { pass: boolean, reason: string }.
 * No side effects. No async. No mutations.
 * Each gate is independently testable.
 *
 * Gates are called IN ORDER by the state machine.
 * A token cannot reach gate N without passing gate N-1.
 */

import {
  UNLOCK_MC_USD, ENTRY_MC_MIN, ENTRY_MC_MAX, MAX_POOL_SOL,
  QUALITY_MIN_BUYERS, QUALITY_MAX_BUY_SOL, QUALITY_MC_THRESHOLD,
  BUNDLE_TXN_THRESHOLD, HISTORY_MIN_TRADES,
  FLOOR_ARM_ZONE_PCT, FLOOR_MIN_TOUCHES, FLOOR_TOUCH_PCT,
  CATALYST_MIN_SOL, CATALYST_MAX_SPIKE,
  MAX_CONCURRENT, MAX_TRADES_PER_TOKEN,
  REENTRY_MAX_ABOVE_EXIT, REENTRY_COOLDOWN_SECS,
  SELLER_EXIT_SOL, STOP_LOSS_PCT, TAKE_PROFIT_PCT,
  TRAIL_ACTIVATE_PCT, TRAIL_KEEP_PCT, MAX_HOLD_SECS,
  CONVICTION_HOLD_SECS, CONVICTION_SELL_RATIO,
  SELLER_EXIT_MIN_HOLD, MIN_HOLD_SECS,
  MAYHEM_AGENT_WALLET, STATE,
} from './rules.js';

// ── helpers ──────────────────────────────────────────────────────
const pass = (reason)        => ({ pass: true,  reason });
const fail = (reason)        => ({ pass: false, reason });
const pct  = (a, b)          => ((a - b) / b * 100).toFixed(1) + '%';

// ── GATE 1: History Gate ─────────────────────────────────────────
// Token must have full on-chain history loaded.
// No history = can never trade. No exceptions. Ever.
export function historyGate(token) {
  if (!token.historyLoaded)
    return fail(`history not loaded yet`);
  if (token.historyTrades < HISTORY_MIN_TRADES)
    return fail(`only ${token.historyTrades} historical trades, need ${HISTORY_MIN_TRADES}`);
  return pass(`history loaded (${token.historyTrades} trades)`);
}

// ── GATE 2: Quality Gate ─────────────────────────────────────────
// Filters out bundles, whales, low-holder tokens.
export function qualityGate(token) {
  if (token.bundled)
    return fail(`bundled at launch (${token.bundleTxCount} txns in 1.5s)`);
  if (token.mayhemDetected)
    return fail(`mayhem agent detected`);
  if (token.uniqueBuyers < QUALITY_MIN_BUYERS)
    return fail(`only ${token.uniqueBuyers} unique buyers, need ${QUALITY_MIN_BUYERS}`);
  if (token.maxEarlyBuySol > QUALITY_MAX_BUY_SOL)
    return fail(`whale buy detected: ${token.maxEarlyBuySol.toFixed(2)} SOL while MC <$${QUALITY_MC_THRESHOLD}`);
  if (token.vSol > MAX_POOL_SOL)
    return fail(`pool too large: ${token.vSol.toFixed(0)} SOL (max ${MAX_POOL_SOL})`);
  return pass(`quality ok (${token.uniqueBuyers} buyers, no whales, no bundle)`);
}

// ── GATE 3: Floor Gate ───────────────────────────────────────────
// The REAL floor is the session low — the lowest price the token has ever traded at.
// It must have been tested at least FLOOR_MIN_TOUCHES times.
// We only care about the absolute lowest confirmed level.
export function floorGate(token) {
  const floor = token.sessionLow;
  if (!floor || floor <= 0 || floor === Infinity)
    return fail(`no session low established yet`);

  // Count how many times price has touched near the session low
  const touches = (token.mcHistory || []).filter(h =>
    h.mc <= floor * (1 + FLOOR_TOUCH_PCT) && h.mc >= floor * (1 - FLOOR_TOUCH_PCT)
  ).length;

  if (touches < FLOOR_MIN_TOUCHES)
    return fail(`floor at $${floor.toFixed(0)} only touched ${touches}x, need ${FLOOR_MIN_TOUCHES}`);

  return pass(`floor confirmed at $${floor.toFixed(0)} (${touches} touches)`);
}

// ── GATE 4: Arm Zone Gate ────────────────────────────────────────
// Current price must be AT or NEAR the floor to arm.
// If price is mid-range or at a bounce level — we wait.
// This is what prevents entering at $11K when floor is $6.7K.
export function armZoneGate(token) {
  const floor   = token.sessionLow;
  const current = token.currentMc;

  if (!floor || !current) return fail(`missing floor or current MC`);

  const aboveFloor = (current - floor) / floor;

  if (aboveFloor > FLOOR_ARM_ZONE_PCT)
    return fail(`price $${current.toFixed(0)} is ${pct(current, floor)} above floor $${floor.toFixed(0)} — not in arm zone (max ${(FLOOR_ARM_ZONE_PCT*100).toFixed(0)}% above floor)`);

  if (current < floor * 0.85)
    return fail(`price $${current.toFixed(0)} is below floor — possible floor break`);

  return pass(`price $${current.toFixed(0)} is within arm zone (${pct(current, floor)} above floor $${floor.toFixed(0)})`);
}

// ── GATE 5: Entry MC Gate ────────────────────────────────────────
// Token must be in our tradeable MC range.
export function entryMcGate(token) {
  const mc = token.currentMc;
  if (!mc || mc < ENTRY_MC_MIN)
    return fail(`MC $${mc?.toFixed(0)} below minimum $${ENTRY_MC_MIN}`);
  if (mc > ENTRY_MC_MAX)
    return fail(`MC $${mc?.toFixed(0)} above maximum $${ENTRY_MC_MAX}`);
  return pass(`MC $${mc.toFixed(0)} in range $${ENTRY_MC_MIN}-$${ENTRY_MC_MAX}`);
}

// ── GATE 6: Re-entry Gate ────────────────────────────────────────
// Never re-enter a token above its last exit price.
// Wallet data shows: re-entering higher = chasing = losses.
export function reentryGate(token) {
  const now = Date.now() / 1000;

  // Blacklisted after too many trades
  if (token.tradeCount >= MAX_TRADES_PER_TOKEN)
    return fail(`trade cap hit (${token.tradeCount} trades on this token)`);
  if (token.blacklistedUntil && now < token.blacklistedUntil)
    return fail(`blacklisted for ${(token.blacklistedUntil - now).toFixed(0)}s more`);

  // Cooldown
  if (token.cooldownUntil && now < token.cooldownUntil)
    return fail(`cooldown: ${(token.cooldownUntil - now).toFixed(0)}s remaining`);

  // Price gate — cannot re-enter above last exit
  if (token.lastExitMc && token.currentMc > token.lastExitMc * (1 + REENTRY_MAX_ABOVE_EXIT))
    return fail(`price $${token.currentMc.toFixed(0)} is above last exit $${token.lastExitMc.toFixed(0)} — not chasing`);

  return pass(token.lastExitMc
    ? `re-entry ok (current $${token.currentMc.toFixed(0)} ≤ last exit $${token.lastExitMc.toFixed(0)})`
    : `first entry on this token`);
}

// ── GATE 7: Concurrency Gate ─────────────────────────────────────
// Never exceed max concurrent open positions.
export function concurrencyGate(openCount) {
  if (openCount >= MAX_CONCURRENT)
    return fail(`at max concurrent positions (${openCount}/${MAX_CONCURRENT})`);
  return pass(`${openCount}/${MAX_CONCURRENT} positions open`);
}

// ── GATE 8: Catalyst Gate ────────────────────────────────────────
// Must be a BUY tick. Must be >= CATALYST_MIN_SOL.
// Must not have spiked price too much (entering at local high).
// This is the final gate before execution.
export function catalystGate(token, isBuy, solAmount, currentMc) {
  if (!isBuy)
    return fail(`not a buy tick — catalyst must be a buy`);

  if (solAmount < CATALYST_MIN_SOL)
    return fail(`catalyst too small: ${solAmount.toFixed(3)} SOL < ${CATALYST_MIN_SOL} SOL`);

  // Check if this buy spiked price too hard (we'd be entering at local high)
  const hist    = token.mcHistory || [];
  const preCat  = hist.length >= 2 ? hist[hist.length - 2]?.mc : null;
  if (preCat && preCat > 0) {
    const spike = (currentMc - preCat) / preCat;
    if (spike > CATALYST_MAX_SPIKE)
      return fail(`catalyst spiked price +${(spike*100).toFixed(1)}% — entering at local high (max ${(CATALYST_MAX_SPIKE*100).toFixed(0)}%)`);
    if (spike < -0.03)
      return fail(`tick is bearish: price dropped ${(spike*100).toFixed(1)}% on supposed catalyst`);
  }

  return pass(`catalyst confirmed: ${solAmount.toFixed(3)} SOL buy at $${currentMc.toFixed(0)}`);
}

// ── EXIT GATES (called after hold timer unlocks) ─────────────────

// Exit Gate 1: STOP LOSS — always instant, no hold gate
// This is the ONLY exit that bypasses MIN_HOLD_SECS
export function stopLossGate(trade, currentMc) {
  const pnlPct = (currentMc - trade.entryMc) / trade.entryMc * 100;
  if (pnlPct <= -STOP_LOSS_PCT)
    return { exit: true, reason: 'STOP_LOSS', pnlPct };
  return { exit: false };
}

// Exit Gate 2: SELLER EXIT — big sell on top of us
// Requires SELLER_EXIT_MIN_HOLD seconds (shorter than normal hold)
export function sellerExitGate(trade, isBuy, solAmount, holdSec) {
  if (isBuy) return { exit: false };
  if (holdSec < SELLER_EXIT_MIN_HOLD)
    return { exit: false, reason: `seller exit blocked: only ${holdSec.toFixed(1)}s hold (need ${SELLER_EXIT_MIN_HOLD}s)` };
  if (solAmount >= SELLER_EXIT_SOL)
    return { exit: true, reason: 'SELLER_EXIT', detail: `${solAmount.toFixed(3)} SOL sell detected` };
  return { exit: false };
}

// Exit Gate 3: TAKE PROFIT — dynamic based on conviction
export function takeProfitGate(trade, currentMc, holdSec) {
  if (holdSec < MIN_HOLD_SECS) return { exit: false };

  const pnlPct  = (currentMc - trade.entryMc) / trade.entryMc * 100;
  const peakPnl = (trade.peakMc - trade.entryMc) / trade.entryMc * 100;

  // Dynamic TP — raise TP if conviction is strong (mostly buys since entry)
  const buyRatio = trade.totalVol > 0 ? trade.buyVol / trade.totalVol : 0.5;
  let effectiveTP = TAKE_PROFIT_PCT;
  if (buyRatio > 0.80 && peakPnl > 5) effectiveTP = 999; // let it run — trail only
  else if (buyRatio > 0.65)           effectiveTP = TAKE_PROFIT_PCT * 1.3;

  if (pnlPct >= effectiveTP)
    return { exit: true, reason: 'TAKE_PROFIT', pnlPct };

  // Trailing stop
  if (peakPnl >= TRAIL_ACTIVATE_PCT) {
    const trailFloor = peakPnl * TRAIL_KEEP_PCT;
    if (pnlPct < trailFloor)
      return { exit: true, reason: 'TRAIL_STOP', pnlPct, peakPnl };
  }

  return { exit: false };
}

// Exit Gate 4: CONVICTION FADE — sells dominating, losing
// Requires CONVICTION_HOLD_SECS (60s) — wallet data shows losers held 125-318s avg
// We cut faster but still need enough data to judge conviction
export function convictionGate(trade, holdSec) {
  if (holdSec < CONVICTION_HOLD_SECS) return { exit: false };

  const pnlPct   = (trade.currentMc - trade.entryMc) / trade.entryMc * 100;
  const sellRatio = trade.totalVol > 0 ? trade.sellVol / trade.totalVol : 0;

  if (sellRatio > (1 - 1/CONVICTION_SELL_RATIO) && pnlPct < 0)
    return { exit: true, reason: 'CONVICTION_FADE', pnlPct };

  return { exit: false };
}

// Exit Gate 5: MAX HOLD — hard cap, no zombie trades
export function maxHoldGate(holdSec) {
  if (holdSec >= MAX_HOLD_SECS)
    return { exit: true, reason: 'MAX_HOLD' };
  return { exit: false };
}

// ── RUN ALL ENTRY GATES IN ORDER ─────────────────────────────────
// This is the only function that should call entry gates.
// Returns first failure or final pass. Logs every gate.
export function runEntryGates(token, isBuy, solAmount, currentMc, openCount, log) {
  const gates = [
    ['HISTORY',     () => historyGate(token)],
    ['QUALITY',     () => qualityGate(token)],
    ['FLOOR',       () => floorGate(token)],
    ['ARM_ZONE',    () => armZoneGate(token)],
    ['ENTRY_MC',    () => entryMcGate(token)],
    ['RE_ENTRY',    () => reentryGate(token)],
    ['CONCURRENCY', () => concurrencyGate(openCount)],
    ['CATALYST',    () => catalystGate(token, isBuy, solAmount, currentMc)],
  ];

  for (const [name, fn] of gates) {
    const result = fn();
    if (!result.pass) {
      log('GATE_FAIL', token.symbol, token.mint, { gate: name, reason: result.reason });
      return { pass: false, gate: name, reason: result.reason };
    }
    log('GATE_PASS', token.symbol, token.mint, { gate: name, reason: result.reason });
  }

  return { pass: true, gate: 'ALL', reason: 'all 8 gates passed' };
}

// ── RUN ALL EXIT GATES IN ORDER ──────────────────────────────────
export function runExitGates(trade, token, isBuy, solAmount, holdSec, log) {
  const mc = token.currentMc;

  // Stop loss is ALWAYS checked first — no hold minimum
  const sl = stopLossGate(trade, mc);
  if (sl.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'STOP_LOSS', pnl: sl.pnlPct?.toFixed(1) });
    return sl;
  }

  // All other exits require hold minimum
  if (holdSec < MIN_HOLD_SECS) {
    log('EXIT_BLOCKED', token.symbol, token.mint, { holdSec: holdSec.toFixed(1), need: MIN_HOLD_SECS });
    return { exit: false };
  }

  const checks = [
    sellerExitGate(trade, isBuy, solAmount, holdSec),
    takeProfitGate(trade, mc, holdSec),
    convictionGate(trade, holdSec),
    maxHoldGate(holdSec),
  ];

  for (const result of checks) {
    if (result.exit) {
      log('EXIT_GATE', token.symbol, token.mint, { gate: result.reason, holdSec: holdSec.toFixed(1) });
      return result;
    }
  }

  return { exit: false };
}
