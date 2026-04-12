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
  CATALYST_MIN_SOL,
  MAX_CONCURRENT, MAX_TRADES_PER_TOKEN,
  REENTRY_MAX_ABOVE_EXIT, REENTRY_COOLDOWN_SECS,
  SELLER_EXIT_SOL, STOP_LOSS_PCT, TAKE_PROFIT_PCT,
  TRAIL_ACTIVATE_PCT, TRAIL_KEEP_PCT, MAX_HOLD_SECS,
  MIN_HOLD_SECS,
  MAYHEM_AGENT_WALLET, STATE,
} from './rules.js';

// ── helpers ──────────────────────────────────────────────────────
const pass = (reason)        => ({ pass: true,  reason });
const fail = (reason)        => ({ pass: false, reason });
const pct  = (a, b)          => ((a - b) / b * 100).toFixed(1) + '%';

// ── GATE 1: History Gate ─────────────────────────────────────────
// Token must have full on-chain history loaded.
// For brand-new tokens (0 Helius trades), live ticks count too.
// No history = can never trade. No exceptions. Ever.
export function historyGate(token) {
  if (!token.historyLoaded)
    return fail(`history not loaded yet`);
  const total = (token.historyTrades || 0) + (token.liveTrades || 0);
  if (total < HISTORY_MIN_TRADES)
    return fail(`only ${total} total trades (hist:${token.historyTrades} live:${token.liveTrades||0}), need ${HISTORY_MIN_TRADES}`);
  return pass(`history ok (${token.historyTrades} on-chain + ${token.liveTrades||0} live)`);
}

// ── GATE 2: Quality Gate ─────────────────────────────────────────
// New pairs: checks bundle, whales, buyer count.
// Old/migrated pairs: skip buyer/bundle (that data doesn't exist) — only check pool size.
export function qualityGate(token) {
  // Mayhem check applies to all categories
  if (token.mayhemDetected)
    return fail(`mayhem agent detected`);

  // Pool size check applies to all categories — vSol must be tracked by runner
  if (token.vSol > MAX_POOL_SOL)
    return fail(`pool too large: ${token.vSol.toFixed(1)} SOL (max ${MAX_POOL_SOL})`);

  // Bundle check applies to ALL categories — old coins can be bundled too
  if (token.bundled)
    return fail(`bundled at launch (${token.bundleTxCount} txns same wallet in 2s)`);

  // New pairs only: whale + buyer count
  if (token.category === 'new') {

    if (token.maxEarlyBuySol > QUALITY_MAX_BUY_SOL)
      return fail(`whale buy: ${token.maxEarlyBuySol.toFixed(2)} SOL while MC <$${QUALITY_MC_THRESHOLD}`);

    // Take the MAX of live-observed and historically resolved buyer counts.
    // resolvedBuyerCount is set in loadHistory from Helius data + live ticks at that point.
    // uniqueBuyers.size only has buyers seen during our current observation window.
    const buyerCount = Math.max(
      token.uniqueBuyers?.size ?? 0,
      token.resolvedBuyerCount ?? 0
    );
    if (buyerCount < QUALITY_MIN_BUYERS)
      return fail(`only ${buyerCount} unique buyers, need ${QUALITY_MIN_BUYERS}`);

    return pass(`quality ok (${buyerCount} buyers, no whale, no bundle)`);
  }

  // Old / migrated pairs pass quality if pool is within limit
  return pass(`quality ok (${token.category} pair — buyer/bundle check skipped)`);
}

// ── GATE 3: Floor Gate ───────────────────────────────────────────
// The REAL floor is the session low — the lowest price the token has ever traded at.
// It must have been tested at least FLOOR_MIN_TOUCHES times.
//
// IMPORTANT: mcHistory is a 5-min rolling window. Historical ticks get pruned on the
// first live tick. We therefore store historyFloorTouches separately during history
// loading so this gate doesn't lose its evidence on the first live tick.
export function floorGate(token) {
  const floor = token.sessionLow;
  if (!floor || floor <= 0 || floor === Infinity)
    return fail(`no session low established yet`);

  // Live touches from rolling window
  const liveTouches = (token.mcHistory || []).filter(h =>
    h.mc <= floor * (1 + FLOOR_TOUCH_PCT) && h.mc >= floor * (1 - FLOOR_TOUCH_PCT)
  ).length;

  // Historical touches survive the rolling window purge (set during history loading)
  const histTouches = token.historyFloorTouches || 0;

  // Confirmed touches locked in at arm time — prevents rolling window from purging evidence.
  // When the FLOORED→ARMED transition fires, we snapshot the touch count.
  // Without this, a token can arm correctly but then fail runEntryGates 60s later
  // because the 5-min mcHistory scrolled past the floor evidence.
  const confirmedTouches = token.confirmedFloorTouches || 0;

  // Use whichever is highest — all sources are valid evidence
  const touches = Math.max(liveTouches, histTouches, confirmedTouches);

  if (touches < FLOOR_MIN_TOUCHES)
    return fail(`floor at $${floor.toFixed(0)} only touched ${touches}x, need ${FLOOR_MIN_TOUCHES} (live:${liveTouches} hist:${histTouches})`);

  return pass(`floor confirmed at $${floor.toFixed(0)} (${touches} touches — live:${liveTouches} hist:${histTouches})`);
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

// ── GATE 8: Sell Pressure Gate ───────────────────────────────────
// Pure order-flow check: if recent ticks are sell-dominated, the level is weak.
// Entering into selling momentum = catching a knife. Wait for buying to resume.
export function sellPressureGate(token) {
  const recent = (token.mcHistory || []).slice(-12);
  if (recent.length < 4) return pass(`too few ticks for pressure read (${recent.length})`);
  let buySol = 0, sellSol = 0;
  for (const h of recent) {
    if (h.isBuy) buySol += (h.sol || 0);
    else sellSol += (h.sol || 0);
  }
  if (sellSol > buySol * 2.5 && sellSol > 0.3)
    return fail(`sell pressure: ${sellSol.toFixed(2)} SOL sold vs ${buySol.toFixed(2)} bought in last ${recent.length} ticks`);
  return pass(`order flow ok: ${buySol.toFixed(2)} bought / ${sellSol.toFixed(2)} sold`);
}

// ── GATE 9: Catalyst Gate ────────────────────────────────────────
// Must be a BUY tick. Must be >= CATALYST_MIN_SOL.
// Fire on the FIRST qualifying buy — we want to be the first bid, not exit liq.
// No momentum waiting. No spike checks. The order book handles the rest post-entry.
export function catalystGate(token, isBuy, solAmount, currentMc) {
  if (!isBuy)
    return fail(`not a buy tick — catalyst must be a buy`);

  if (solAmount < CATALYST_MIN_SOL)
    return fail(`catalyst too small: ${solAmount.toFixed(3)} SOL < ${CATALYST_MIN_SOL} SOL`);

  return pass(`catalyst: ${solAmount.toFixed(3)} SOL buy at $${currentMc.toFixed(0)}`);
}

// ── EXIT GATES — Pure Order Flow ─────────────────────────────────
// No time locks. The order book decides, not a clock.
// Our bid tests a price level. If the level rejects us, we get out NOW.

// Exit Gate 1: STOP LOSS — safety net for price bleeding without big sells
export function stopLossGate(trade, currentMc) {
  const pnlPct = (currentMc - trade.entryMc) / trade.entryMc * 100;
  if (pnlPct <= -STOP_LOSS_PCT)
    return { exit: true, reason: 'STOP_LOSS', pnlPct };
  return { exit: false };
}

// Exit Gate 2: SELLER EXIT — sell appears on top of us = level rejected = out NOW
// No hold timer. This is the primary exit signal.
// Threshold scales with pool size: 0.5% of vSol means the sell is meaningful
// relative to the token's liquidity, not just a flat number.
export function sellerExitGate(trade, isBuy, solAmount, vSol) {
  if (isBuy) return { exit: false };
  const dynamicThreshold = Math.max(SELLER_EXIT_SOL, (vSol || 30) * 0.005);
  if (solAmount >= dynamicThreshold)
    return { exit: true, reason: 'SELLER_EXIT', detail: `${solAmount.toFixed(3)} SOL sell >= ${dynamicThreshold.toFixed(3)} threshold (0.5% of ${(vSol||30).toFixed(0)} SOL pool)` };
  return { exit: false };
}

// Exit Gate 3: TAKE PROFIT — trail from early, let winners run
export function takeProfitGate(trade, currentMc) {
  const pnlPct  = (currentMc - trade.entryMc) / trade.entryMc * 100;
  const peakPnl = (trade.peakMc - trade.entryMc) / trade.entryMc * 100;

  if (pnlPct >= TAKE_PROFIT_PCT)
    return { exit: true, reason: 'TAKE_PROFIT', pnlPct };

  // Trailing stop — activates at +3%, keeps 60% of peak
  if (peakPnl >= TRAIL_ACTIVATE_PCT) {
    const trailFloor = peakPnl * TRAIL_KEEP_PCT;
    if (pnlPct < trailFloor)
      return { exit: true, reason: 'TRAIL_STOP', pnlPct, peakPnl };
  }

  return { exit: false };
}

// Exit Gate 4: MAX HOLD — zombie prevention only
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
    ['HISTORY',       () => historyGate(token)],
    ['QUALITY',       () => qualityGate(token)],
    ['FLOOR',         () => floorGate(token)],
    ['ARM_ZONE',      () => armZoneGate(token)],
    ['ENTRY_MC',      () => entryMcGate(token)],
    ['RE_ENTRY',      () => reentryGate(token)],
    ['CONCURRENCY',   () => concurrencyGate(openCount)],
    ['SELL_PRESSURE', () => sellPressureGate(token)],
    ['CATALYST',      () => catalystGate(token, isBuy, solAmount, currentMc)],
  ];

  for (const [name, fn] of gates) {
    const result = fn();
    if (!result.pass) {
      log('GATE_FAIL', token.symbol, token.mint, { gate: name, reason: result.reason });
      return { pass: false, gate: name, reason: result.reason };
    }
    log('GATE_PASS', token.symbol, token.mint, { gate: name, reason: result.reason });
  }

  return { pass: true, gate: 'ALL', reason: 'all 9 gates passed' };
}

// ── RUN ALL EXIT GATES IN ORDER ──────────────────────────────────
// Pure order flow — no time locks. Every tick is checked immediately.
export function runExitGates(trade, token, isBuy, solAmount, holdSec, log) {
  const mc = token.currentMc;

  // 1. Stop loss — safety net first (price bleed without big sells)
  const sl = stopLossGate(trade, mc);
  if (sl.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'STOP_LOSS', pnl: sl.pnlPct?.toFixed(1) });
    return sl;
  }

  // 2. Seller exit — level rejected, out now (no hold timer)
  const se = sellerExitGate(trade, isBuy, solAmount, token.vSol);
  if (se.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'SELLER_EXIT', holdSec: holdSec.toFixed(1) });
    return se;
  }

  // 3. Take profit / trail
  const tp = takeProfitGate(trade, mc);
  if (tp.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: tp.reason, pnl: tp.pnlPct?.toFixed(1) });
    return tp;
  }

  // 4. Max hold — zombie prevention
  const mh = maxHoldGate(holdSec);
  if (mh.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'MAX_HOLD', holdSec: holdSec.toFixed(1) });
    return mh;
  }

  return { exit: false };
}
