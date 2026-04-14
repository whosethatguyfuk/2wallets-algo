/**
 * gates.js — PURE GATE FUNCTIONS
 *
 * Every gate returns { pass: boolean, reason: string }.
 * No side effects. No async. No mutations.
 * Each gate is independently testable.
 *
 * v3.3 — Dual-mode: QUICK (seller exit) vs HOLD (DCA sell).
 * QUICK = new/weak tokens → fast in/out, any sell = instant exit.
 * HOLD  = proven/ranged tokens → bid floor, hold for 2-3x, DCA sell.
 */

import {
  ENTRY_MC_MIN, ENTRY_MC_MAX, MAX_POOL_SOL,
  QUALITY_MIN_BUYERS, QUALITY_MIN_BUYERS_OLD, QUALITY_MAX_BUY_SOL, QUALITY_MC_THRESHOLD,
  HISTORY_MIN_TRADES,
  FLOOR_ARM_ZONE_PCT, FLOOR_MIN_TOUCHES, FLOOR_TOUCH_PCT,
  CATALYST_MIN_SOL,
  MAX_CONCURRENT, MAX_TRADES_PER_TOKEN,
  REENTRY_MAX_ABOVE_EXIT, REENTRY_COOLDOWN_SECS,
  DCA_TRANCHE_0_MULT, DCA_TRANCHE_1_MULT, DCA_TRANCHE_2_MULT, DCA_TRANCHE_3_MULT,
  HOLD_STOP_PCT, HOLD_MAX_HOLD_SECS,
  QUICK_STOP_PCT, QUICK_TP_PCT, QUICK_MAX_HOLD_SECS,
  BOND_MC_SELL,
  MAYHEM_AGENT_WALLET, STATE,
} from './rules.js';

// ── helpers ──────────────────────────────────────────────────────
const pass = (reason)        => ({ pass: true,  reason });
const fail = (reason)        => ({ pass: false, reason });
const pct  = (a, b)          => ((a - b) / b * 100).toFixed(1) + '%';

// ═══════════════════════════════════════════════════════════════════
// ENTRY GATES
// ═══════════════════════════════════════════════════════════════════

export function historyGate(token) {
  if ((token.winCount || 0) >= 1)
    return pass(`proven token (${token.winCount} wins)`);
  if (!token.historyLoaded)
    return fail(`history not loaded yet`);
  if (token.isNurseryGrad)
    return pass(`nursery grad — complete data from birth`);
  if ((token.floorTouches || 0) >= 5)
    return pass(`${token.floorTouches} floor touches — data quality proven`);
  const total = (token.historyTrades || 0) + (token.liveTrades || 0);
  if (total < HISTORY_MIN_TRADES)
    return fail(`only ${total} total trades, need ${HISTORY_MIN_TRADES}`);
  return pass(`history ok (${token.historyTrades} on-chain + ${token.liveTrades||0} live)`);
}

export function qualityGate(token) {
  if (token.mayhemDetected)
    return fail(`mayhem agent detected`);
  if (token.vSol > MAX_POOL_SOL)
    return fail(`pool too large: ${token.vSol.toFixed(1)} SOL`);
  if ((token.winCount || 0) >= 1)
    return pass(`proven token`);

  if (token.category === 'new') {
    if (token.maxEarlyBuySol > QUALITY_MAX_BUY_SOL)
      return fail(`whale buy: ${token.maxEarlyBuySol.toFixed(2)} SOL`);
    const buyerCount = Math.max(token.uniqueBuyers?.size ?? 0, token.resolvedBuyerCount ?? 0);
    if (buyerCount < QUALITY_MIN_BUYERS)
      return fail(`only ${buyerCount} unique buyers, need ${QUALITY_MIN_BUYERS}`);
    const r2 = token.jitoBundle ? ' [round-2]' : '';
    return pass(`quality ok (${buyerCount} buyers)${r2}`);
  }

  const buyerCount = Math.max(token.uniqueBuyers?.size ?? 0, token.resolvedBuyerCount ?? 0);
  if (buyerCount < QUALITY_MIN_BUYERS_OLD && (token.floorTouches || 0) < 5)
    return fail(`only ${buyerCount} unique buyers on old pair`);
  return pass(`quality ok (${token.category} pair)`);
}

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
    return fail(`floor $${floor.toFixed(0)} only ${touches}x, need ${FLOOR_MIN_TOUCHES}`);
  return pass(`floor confirmed $${floor.toFixed(0)} (${touches} touches)`);
}

export function armZoneGate(token) {
  const floor   = token.sessionLow;
  const current = token.currentMc;
  if (!floor || !current) return fail(`missing floor or current MC`);
  const aboveFloor = (current - floor) / floor;
  if (aboveFloor > FLOOR_ARM_ZONE_PCT)
    return fail(`$${current.toFixed(0)} is ${pct(current, floor)} above floor $${floor.toFixed(0)} (max ${(FLOOR_ARM_ZONE_PCT*100).toFixed(0)}%)`);
  if (current < floor * 0.85)
    return fail(`$${current.toFixed(0)} below floor — break risk`);
  return pass(`in arm zone (${pct(current, floor)} above floor $${floor.toFixed(0)})`);
}

export function entryMcGate(token) {
  const mc = token.currentMc;
  if (!mc || mc < ENTRY_MC_MIN) return fail(`MC $${mc?.toFixed(0)} below $${ENTRY_MC_MIN}`);
  if (mc > ENTRY_MC_MAX) return fail(`MC $${mc?.toFixed(0)} above $${ENTRY_MC_MAX}`);
  return pass(`MC $${mc.toFixed(0)} in range`);
}

export function reentryGate(token) {
  const now = Date.now() / 1000;
  if (token.tradeCount >= MAX_TRADES_PER_TOKEN)
    return fail(`trade cap hit (${token.tradeCount})`);
  if (token.blacklistedUntil && now < token.blacklistedUntil)
    return fail(`blacklisted ${(token.blacklistedUntil - now).toFixed(0)}s`);
  if (token.cooldownUntil && now < token.cooldownUntil)
    return fail(`cooldown: ${(token.cooldownUntil - now).toFixed(0)}s`);
  if (token.lastExitMc && token.currentMc > token.lastExitMc * (1 + REENTRY_MAX_ABOVE_EXIT))
    return fail(`$${token.currentMc.toFixed(0)} above last exit $${token.lastExitMc.toFixed(0)}`);
  return pass(token.lastExitMc
    ? `re-entry ok ($${token.currentMc.toFixed(0)} ≤ $${token.lastExitMc.toFixed(0)})`
    : `first entry`);
}

export function concurrencyGate(openCount) {
  if (openCount >= MAX_CONCURRENT)
    return fail(`max positions (${openCount}/${MAX_CONCURRENT})`);
  return pass(`${openCount}/${MAX_CONCURRENT} open`);
}

export function sellPressureGate(token) {
  const hist = token.mcHistory || [];
  const recent = hist.length > 1 ? hist.slice(-13, -1) : [];
  const minTicks = (token.category === 'old' || token.isSeeded || (token.winCount || 0) >= 1) ? 2 : 4;
  if (recent.length < minTicks) return fail(`only ${recent.length} ticks (need ${minTicks})`);
  let buySol = 0, sellSol = 0;
  for (const h of recent) { if (h.isBuy) buySol += (h.sol || 0); else sellSol += (h.sol || 0); }
  const recentBuys = recent.filter(h => h.isBuy).length;
  if (recentBuys === 0) return fail(`no pre-catalyst buying`);
  if (sellSol > buySol * 2.5 && sellSol > 0.3)
    return fail(`sell pressure: ${sellSol.toFixed(2)} vs ${buySol.toFixed(2)} bought`);
  return pass(`flow ok: ${buySol.toFixed(2)}/${sellSol.toFixed(2)} (${recentBuys} buys)`);
}

export function catalystGate(token, isBuy, solAmount, currentMc) {
  if (!isBuy) return fail(`not a buy`);
  return pass(`buy at floor: ${solAmount.toFixed(3)} SOL at $${currentMc.toFixed(0)}`);
}

// ═══════════════════════════════════════════════════════════════════
// EXIT GATES — QUICK MODE (new/weak tokens)
// ═══════════════════════════════════════════════════════════════════

/**
 * Seller exit: if ANYONE sells while we're holding → instant exit.
 * The logic: we're testing the floor. Any sell = floor rejected = get out.
 */
export function sellerExitGate(isBuy) {
  if (!isBuy)
    return { exit: true, reason: 'SELLER_EXIT', detail: 'sell tick — floor rejected' };
  return { exit: false };
}

/**
 * Quick stop: 4% below entry price.
 */
export function quickStopGate(trade, currentMc) {
  const stopLevel = trade.entryMc * (1 - QUICK_STOP_PCT);
  if (currentMc <= stopLevel)
    return { exit: true, reason: 'QUICK_STOP', detail: `$${currentMc.toFixed(0)} ≤ $${stopLevel.toFixed(0)} (-${(QUICK_STOP_PCT*100)}%)` };
  return { exit: false };
}

/**
 * Quick take profit: 15% above entry.
 */
export function quickTpGate(trade, currentMc) {
  const target = trade.entryMc * (1 + QUICK_TP_PCT);
  if (currentMc >= target)
    return { exit: true, reason: 'QUICK_TP', detail: `$${currentMc.toFixed(0)} ≥ $${target.toFixed(0)} (+${(QUICK_TP_PCT*100)}%)` };
  return { exit: false };
}

/**
 * Quick max hold: 3 minutes.
 */
export function quickMaxHoldGate(holdSec) {
  if (holdSec >= QUICK_MAX_HOLD_SECS)
    return { exit: true, reason: 'QUICK_MAX_HOLD' };
  return { exit: false };
}

// ═══════════════════════════════════════════════════════════════════
// EXIT GATES — HOLD MODE (proven/strong tokens)
// ═══════════════════════════════════════════════════════════════════

export function dcaExitGate(trade, currentMc) {
  const mult = currentMc / trade.entryMc;
  const soldTranches = trade.tranchesSold || 0;

  if (soldTranches === 0 && mult >= DCA_TRANCHE_0_MULT)
    return { sell: true, tranche: 1, pct: 0.20, reason: `DCA_T0`, detail: `${mult.toFixed(2)}x (≥${DCA_TRANCHE_0_MULT}x)` };
  if (soldTranches === 1 && mult >= DCA_TRANCHE_1_MULT)
    return { sell: true, tranche: 2, pct: 0.25, reason: `DCA_T1`, detail: `${mult.toFixed(2)}x (≥${DCA_TRANCHE_1_MULT}x)` };
  if (soldTranches === 2 && mult >= DCA_TRANCHE_2_MULT)
    return { sell: true, tranche: 3, pct: 0.25, reason: `DCA_T2`, detail: `${mult.toFixed(2)}x (≥${DCA_TRANCHE_2_MULT}x)` };
  if (soldTranches === 3 && mult >= DCA_TRANCHE_3_MULT)
    return { sell: true, tranche: 4, pct: 0.30, reason: `DCA_T3`, detail: `${mult.toFixed(2)}x (≥${DCA_TRANCHE_3_MULT}x)` };

  return { sell: false };
}

export function holdStopGate(trade, currentMc) {
  const stopLevel = trade.entryMc * (1 - HOLD_STOP_PCT);
  if (currentMc <= stopLevel)
    return { exit: true, reason: 'HOLD_STOP', detail: `$${currentMc.toFixed(0)} ≤ $${stopLevel.toFixed(0)} (-${(HOLD_STOP_PCT*100)}%)` };
  return { exit: false };
}

export function bondCapGate(trade, currentMc) {
  if (currentMc >= BOND_MC_SELL)
    return { exit: true, reason: 'BOND_CAP', detail: `MC $${currentMc.toFixed(0)} ≥ $${BOND_MC_SELL}` };
  return { exit: false };
}

export function holdMaxHoldGate(holdSec) {
  if (holdSec >= HOLD_MAX_HOLD_SECS)
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

// ── RUN EXIT GATES — branches on trade.mode ──────────────────────
export function runExitGates(trade, token, isBuy, solAmount, holdSec, log) {
  const mc = token.currentMc;

  // ──────────────────────────────────────────────────────────────
  // QUICK MODE: seller exit, tight stop, quick TP, short hold
  // ──────────────────────────────────────────────────────────────
  if (trade.mode === 'QUICK') {
    // 1. Stop loss — 4% hard stop (check first before seller exit)
    const qs = quickStopGate(trade, mc);
    if (qs.exit) {
      log('EXIT_GATE', token.symbol, token.mint, { gate: 'QUICK_STOP', detail: qs.detail, mode: 'QUICK' });
      return { exit: true, reason: qs.reason, sellAll: true };
    }

    // 2. Bond cap
    const bc = bondCapGate(trade, mc);
    if (bc.exit) {
      log('EXIT_GATE', token.symbol, token.mint, { gate: 'BOND_CAP', detail: bc.detail, mode: 'QUICK' });
      return { exit: true, reason: bc.reason, sellAll: true };
    }

    // 3. Take profit — 15%
    const tp = quickTpGate(trade, mc);
    if (tp.exit) {
      log('EXIT_GATE', token.symbol, token.mint, { gate: 'QUICK_TP', detail: tp.detail, mode: 'QUICK' });
      return { exit: true, reason: tp.reason, sellAll: true };
    }

    // 4. Max hold — 3 min
    const mh = quickMaxHoldGate(holdSec);
    if (mh.exit) {
      log('EXIT_GATE', token.symbol, token.mint, { gate: 'QUICK_MAX_HOLD', holdSec: holdSec.toFixed(0), mode: 'QUICK' });
      return { exit: true, reason: mh.reason, sellAll: true };
    }

    // 5. Seller exit — any sell tick = floor rejected = get out
    const se = sellerExitGate(isBuy);
    if (se.exit) {
      log('EXIT_GATE', token.symbol, token.mint, { gate: 'SELLER_EXIT', detail: se.detail, mode: 'QUICK' });
      return { exit: true, reason: se.reason, sellAll: true };
    }

    return { exit: false };
  }

  // ──────────────────────────────────────────────────────────────
  // HOLD MODE: DCA sell, stop, bond cap, max hold
  // ──────────────────────────────────────────────────────────────

  // 1. Stop loss — 6% hard stop
  const sl = holdStopGate(trade, mc);
  if (sl.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'HOLD_STOP', detail: sl.detail, mode: 'HOLD' });
    return { exit: true, reason: sl.reason, sellAll: true };
  }

  // 2. Bond cap — sell everything near bonding curve
  const bc = bondCapGate(trade, mc);
  if (bc.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'BOND_CAP', detail: bc.detail, mode: 'HOLD' });
    return { exit: true, reason: bc.reason, sellAll: true };
  }

  // 3. Max hold — 45 min
  const mh = holdMaxHoldGate(holdSec);
  if (mh.exit) {
    log('EXIT_GATE', token.symbol, token.mint, { gate: 'MAX_HOLD', holdSec: holdSec.toFixed(0), mode: 'HOLD' });
    return { exit: true, reason: mh.reason, sellAll: true };
  }

  // 4. DCA tranche — partial sell
  const dca = dcaExitGate(trade, mc);
  if (dca.sell) {
    log('EXIT_GATE', token.symbol, token.mint, {
      gate: dca.reason, tranche: dca.tranche, pct: dca.pct, detail: dca.detail, mode: 'HOLD',
    });
    return { exit: true, reason: dca.reason, sellAll: false, tranche: dca.tranche, pct: dca.pct };
  }

  return { exit: false };
}
