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
  ENTRY_MC_MIN, ENTRY_MC_MAX, MAX_POOL_SOL,
  QUALITY_MIN_BUYERS, QUALITY_MIN_BUYERS_OLD, QUALITY_MAX_BUY_SOL, QUALITY_MC_THRESHOLD,
  HISTORY_MIN_TRADES,
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
export function historyGate(token) {
  if (!token.historyLoaded)
    return fail(`history not loaded yet`);
  if (token.isNurseryGrad)
    return pass(`nursery grad — complete data from birth`);
  if ((token.floorTouches || 0) >= 5)
    return pass(`${token.floorTouches} floor touches — data quality proven`);
  const total = (token.historyTrades || 0) + (token.liveTrades || 0);
  if (total < HISTORY_MIN_TRADES)
    return fail(`only ${total} total trades (hist:${token.historyTrades} live:${token.liveTrades||0}), need ${HISTORY_MIN_TRADES}`);
  return pass(`history ok (${token.historyTrades} on-chain + ${token.liveTrades||0} live)`);
}

// ── GATE 2: Quality Gate ─────────────────────────────────────────
// Jito bundles are NOT rejected here — they follow the round-2 path.
// Only mayhem agents and pool-size violations are hard rejections.
export function qualityGate(token) {
  if (token.mayhemDetected)
    return fail(`mayhem agent detected`);

  if (token.vSol > MAX_POOL_SOL)
    return fail(`pool too large: ${token.vSol.toFixed(1)} SOL (max ${MAX_POOL_SOL})`);

  if (token.category === 'new') {
    if (token.maxEarlyBuySol > QUALITY_MAX_BUY_SOL)
      return fail(`whale buy: ${token.maxEarlyBuySol.toFixed(2)} SOL while MC <$${QUALITY_MC_THRESHOLD}`);

    const buyerCount = Math.max(
      token.uniqueBuyers?.size ?? 0,
      token.resolvedBuyerCount ?? 0
    );
    if (buyerCount < QUALITY_MIN_BUYERS)
      return fail(`only ${buyerCount} unique buyers, need ${QUALITY_MIN_BUYERS}`);

    const r2 = token.jitoBundle ? ' [jito-bundle, round-2]' : '';
    return pass(`quality ok (${buyerCount} buyers)${r2}`);
  }

  // Old/seeded tokens still need a minimum buyer count
  const buyerCount = Math.max(
    token.uniqueBuyers?.size ?? 0,
    token.resolvedBuyerCount ?? 0
  );
  if (buyerCount < QUALITY_MIN_BUYERS_OLD)
    return fail(`only ${buyerCount} unique buyers on old pair, need ${QUALITY_MIN_BUYERS_OLD}`);

  const r2 = token.jitoBundle ? ' [jito-bundle, round-2]' : '';
  return pass(`quality ok (${token.category} pair, ${buyerCount} buyers)${r2}`);
}

// ── GATE 3: Floor Gate ───────────────────────────────────────────
export function floorGate(token) {
  const floor = token.sessionLow;
  if (!floor || floor <= 0 || floor === Infinity)
    return fail(`no session low established yet`);

  const liveTouches = (token.mcHistory || []).filter(h =>
    h.mc <= floor * (1 + FLOOR_TOUCH_PCT) && h.mc >= floor * (1 - FLOOR_TOUCH_PCT)
  ).length;

  const histTouches = token.historyFloorTouches || 0;
  const confirmedTouches = token.confirmedFloorTouches || 0;
  const touches = Math.max(liveTouches, histTouches, confirmedTouches);

  if (touches < FLOOR_MIN_TOUCHES)
    return fail(`floor at $${floor.toFixed(0)} only touched ${touches}x, need ${FLOOR_MIN_TOUCHES} (live:${liveTouches} hist:${histTouches})`);

  return pass(`floor confirmed at $${floor.toFixed(0)} (${touches} touches — live:${liveTouches} hist:${histTouches})`);
}

// ── GATE 4: Arm Zone Gate ────────────────────────────────────────
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
export function entryMcGate(token) {
  const mc = token.currentMc;
  if (!mc || mc < ENTRY_MC_MIN)
    return fail(`MC $${mc?.toFixed(0)} below minimum $${ENTRY_MC_MIN}`);
  if (mc > ENTRY_MC_MAX)
    return fail(`MC $${mc?.toFixed(0)} above maximum $${ENTRY_MC_MAX}`);
  return pass(`MC $${mc.toFixed(0)} in range $${ENTRY_MC_MIN}-$${ENTRY_MC_MAX}`);
}

// ── GATE 6: Re-entry Gate ────────────────────────────────────────
export function reentryGate(token) {
  const now = Date.now() / 1000;

  if (token.tradeCount >= MAX_TRADES_PER_TOKEN)
    return fail(`trade cap hit (${token.tradeCount} trades on this token)`);
  if (token.blacklistedUntil && now < token.blacklistedUntil)
    return fail(`blacklisted for ${(token.blacklistedUntil - now).toFixed(0)}s more`);

  if (token.cooldownUntil && now < token.cooldownUntil)
    return fail(`cooldown: ${(token.cooldownUntil - now).toFixed(0)}s remaining`);

  if (token.lastExitMc && token.currentMc > token.lastExitMc * (1 + REENTRY_MAX_ABOVE_EXIT))
    return fail(`price $${token.currentMc.toFixed(0)} is above last exit $${token.lastExitMc.toFixed(0)} — not chasing`);

  return pass(token.lastExitMc
    ? `re-entry ok (current $${token.currentMc.toFixed(0)} ≤ last exit $${token.lastExitMc.toFixed(0)})`
    : `first entry on this token`);
}

// ── GATE 7: Concurrency Gate ─────────────────────────────────────
export function concurrencyGate(openCount) {
  if (openCount >= MAX_CONCURRENT)
    return fail(`at max concurrent positions (${openCount}/${MAX_CONCURRENT})`);
  return pass(`${openCount}/${MAX_CONCURRENT} positions open`);
}

// ── GATE 8: Sell Pressure Gate ───────────────────────────────────
export function sellPressureGate(token) {
  const hist = token.mcHistory || [];
  const recent = hist.length > 1 ? hist.slice(-13, -1) : [];
  // Slow-trading tokens (old/seeded) only need 2 pre-catalyst ticks
  const minTicks = (token.category === 'old' || token.isSeeded) ? 2 : 4;
  if (recent.length < minTicks) return fail(`low activity: only ${recent.length} pre-catalyst ticks (need ${minTicks})`);
  let buySol = 0, sellSol = 0;
  for (const h of recent) {
    if (h.isBuy) buySol += (h.sol || 0);
    else sellSol += (h.sol || 0);
  }
  const recentBuys = recent.filter(h => h.isBuy).length;
  if (recentBuys === 0)
    return fail(`no pre-catalyst buying in last ${recent.length} ticks — isolated catalyst`);
  if (sellSol > buySol * 2.5 && sellSol > 0.3)
    return fail(`sell pressure: ${sellSol.toFixed(2)} SOL sold vs ${buySol.toFixed(2)} bought`);
  return pass(`pre-entry flow ok: ${buySol.toFixed(2)} bought / ${sellSol.toFixed(2)} sold (${recentBuys} buys in ${recent.length} ticks)`);
}

// ── GATE 9: Catalyst Gate ────────────────────────────────────────
export function catalystGate(token, isBuy, solAmount, currentMc) {
  if (!isBuy)
    return fail(`not a buy tick — catalyst must be a buy`);

  if (solAmount < CATALYST_MIN_SOL)
    return fail(`catalyst too small: ${solAmount.toFixed(3)} SOL < ${CATALYST_MIN_SOL} SOL`);

  return pass(`catalyst: ${solAmount.toFixed(3)} SOL buy at $${currentMc.toFixed(0)}`);
}

// ── EXIT GATES ───────────────────────────────────────────────────

export function stopLossGate(trade, currentMc) {
  const pnlPct = (currentMc - trade.entryMc) / trade.entryMc * 100;
  if (pnlPct <= -STOP_LOSS_PCT)
    return { exit: true, reason: 'STOP_LOSS', pnlPct };
  return { exit: false };
}

export function sellerExitGate(trade, isBuy, solAmount, vSol) {
  if (isBuy) return { exit: false };
  const dynamicThreshold = Math.max(SELLER_EXIT_SOL, (vSol || 30) * 0.005);
  if (solAmount >= dynamicThreshold)
    return { exit: true, reason: 'SELLER_EXIT', detail: `${solAmount.toFixed(3)} SOL sell >= ${dynamicThreshold.toFixed(3)} threshold` };
  return { exit: false };
}

export function takeProfitGate(trade, currentMc) {
  const pnlPct  = (currentMc - trade.entryMc) / trade.entryMc * 100;
  const peakPnl = (trade.peakMc - trade.entryMc) / trade.entryMc * 100;

  if (pnlPct >= TAKE_PROFIT_PCT)
    return { exit: true, reason: 'TAKE_PROFIT', pnlPct };

  if (peakPnl >= TRAIL_ACTIVATE_PCT) {
    const trailFloor = peakPnl * TRAIL_KEEP_PCT;
    if (pnlPct < trailFloor)
      return { exit: true, reason: 'TRAIL_STOP', pnlPct, peakPnl };
  }

  return { exit: false };
}

export function maxHoldGate(holdSec) {
  if (holdSec >= MAX_HOLD_SECS)
    return { exit: true, reason: 'MAX_HOLD' };
  return { exit: false };
}

// ── RUN ALL ENTRY GATES IN ORDER ─────────────────────────────────
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
export function runExitGates(trade, token, isBuy, solAmount, holdSec, log) {
  const mc = token.currentMc;

  const sl = stopLossGate(trade, mc);
  if (sl.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'STOP_LOSS', pnl: sl.pnlPct?.toFixed(1) });
    return sl;
  }

  const se = sellerExitGate(trade, isBuy, solAmount, token.vSol);
  if (se.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'SELLER_EXIT', holdSec: holdSec.toFixed(1) });
    return se;
  }

  const tp = takeProfitGate(trade, mc);
  if (tp.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: tp.reason, pnl: tp.pnlPct?.toFixed(1) });
    return tp;
  }

  const mh = maxHoldGate(holdSec);
  if (mh.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'MAX_HOLD', holdSec: holdSec.toFixed(1) });
    return mh;
  }

  return { exit: false };
}
