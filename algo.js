/**
 * algo.js — STATE MACHINE ENGINE  (v3.3 — dual mode: QUICK + HOLD)
 *
 * This file owns the state machine. It does NOT:
 *   - Connect to any WebSocket
 *   - Make any HTTP requests
 *   - Render any UI
 *
 * It ONLY:
 *   - Receives ticks from the runner
 *   - Runs gates in order
 *   - Transitions token state
 *   - Emits trade events back to the runner
 *
 * v3.3 — Dual mode:
 *   QUICK: new/weak tokens → seller exit, 4% stop, 15% TP
 *   HOLD:  strong/ranged tokens → bid floor, DCA sell for 2-3x
 */

import { STATE,
         ARM_TIMEOUT_SECS, TRADE_FEE_PCT, POSITION_SOL,
         MAX_TRADES_PER_TOKEN, FLOOR_TOUCH_PCT,
         FLOOR_ARM_ZONE_PCT, ARM_MIN_ATH_MULT,
         ENTRY_MC_MIN, ROUND2_PUMP_MULT,
         JITO_ROUND2_MIN_ATH, HISTORY_MIN_TRADES,
         REENTRY_COOLDOWN_SECS,
         STRONG_MIN_FLOOR_TOUCHES, STRONG_MIN_ATH_MULT, STRONG_MIN_TICKS,
         HOLD_MAX_HOLD_SECS, QUICK_MAX_HOLD_SECS } from './rules.js';

import { runEntryGates, runExitGates, floorGate } from './gates.js';

// ── Token factory ────────────────────────────────────────────────
export function makeToken(mint, symbol, name, category) {
  return {
    mint, symbol, name, category,

    state:           STATE.WATCHING,
    stateChangedAt:  Date.now(),

    currentMc:       0,
    sessionHigh:     0,
    sessionLow:      Infinity,
    mcHistory:       [],
    vSol:            0,
    prevMcSol:       0,

    historyLoaded:   false,
    historyTrades:   0,
    liveTrades:      0,

    uniqueBuyers:    new Set(),
    maxEarlyBuySol:  0,
    mayhemDetected:  false,

    jitoBundle:      false,
    jitoBundleSlot:  null,
    bundlePeakMc:    0,

    floorMc:         null,
    floorTouches:    0,

    armedAt:         0,
    isNurseryGrad:   false,
    proven:          false,

    activeTrade:     null,
    lastExitMc:      null,
    cooldownUntil:   0,
    blacklistedUntil:0,
    tradeCount:      0,
    winCount:        0,
    closedTrades:    [],
  };
}

// ── State transition ─────────────────────────────────────────────
function transition(token, newState, reason, log) {
  const oldState = token.state;
  token.state          = newState;
  token.stateChangedAt = Date.now();
  log('STATE', token.symbol, token.mint, {
    from: oldState, to: newState, reason,
    mc: Math.round(token.currentMc),
  });
}

// ── Price structure update ───────────────────────────────────────
export function updatePrice(token, mc, ts, isBuy, sol) {
  token.mcHistory.push({ mc, ts, isBuy, sol });
  const cutoff = ts - 300_000;
  while (token.mcHistory.length > 1 && token.mcHistory[0].ts < cutoff)
    token.mcHistory.shift();

  token.currentMc  = mc;
  token.lastTickTs = ts;
  if (mc > token.sessionHigh) token.sessionHigh = mc;

  if (token.mcHistory.length >= 5) {
    let bufMin = Infinity;
    for (const h of token.mcHistory) { if (h.mc < bufMin) bufMin = h.mc; }
    token.sessionLow = bufMin;
  } else if (mc < token.sessionLow && mc > 0) {
    token.sessionLow = mc;
  }

  if (token.sessionLow < Infinity) {
    token.floorTouches = token.mcHistory.filter(h =>
      h.mc <= token.sessionLow * (1 + FLOOR_TOUCH_PCT) &&
      h.mc >= token.sessionLow * (1 - FLOOR_TOUCH_PCT)
    ).length;
  }
}

// ── Jito bundle price reset ─────────────────────────────────────
export function applyJitoBundleReset(token, log) {
  token.jitoBundle = true;
  token.bundlePeakMc = token.sessionHigh;
  token.sessionHigh = 0;
  token.sessionLow = Infinity;
  token.mcHistory = [];
  token.floorTouches = 0;
  token.historyFloorTouches = 0;
  token.confirmedFloorTouches = 0;
  log('JITO_RESET', token.symbol, token.mint, {
    bundlePeak: Math.round(token.bundlePeakMc),
    msg: 'price reset for round-2 organic floor detection',
  });
}

// ── Main tick function ───────────────────────────────────────────
export function onTick(token, mc, ts, isBuy, sol, openCount, isLaser, log) {
  updatePrice(token, mc, ts, isBuy, sol);

  const now    = Date.now();
  const nowSec = now / 1000;

  // ── FIREWALL ───────────────────────────────────────────────────
  if (token.state !== STATE.BLACKLISTED && token.state !== STATE.CLOSED) {
    if (token.mayhemDetected) {
      transition(token, STATE.BLACKLISTED, `FIREWALL: mayhem agent`, log);
      return token.state === STATE.ARMED ? { type: 'DISARM', token } : null;
    }
    if (token.jitoBundle && (token.bundlePeakMc || 0) < JITO_ROUND2_MIN_ATH && token.bundlePeakMc > 0) {
      transition(token, STATE.BLACKLISTED, `FIREWALL: jito bundle ATH $${Math.round(token.bundlePeakMc)} < $${JITO_ROUND2_MIN_ATH}`, log);
      return token.state === STATE.ARMED ? { type: 'DISARM', token } : null;
    }
  }

  // ── IN TRADE: manage DCA exits ─────────────────────────────────
  if (token.state === STATE.HOLDING || token.state === STATE.EXIT_UNLOCKED) {
    const trade = token.activeTrade;
    if (!trade) return null;

    trade.currentMc   = mc;
    trade.totalVol   += sol;
    trade.tickCount   = (trade.tickCount || 0) + 1;
    if (isBuy) trade.buyVol  += sol;
    else       trade.sellVol += sol;
    if (mc > trade.peakMc) trade.peakMc = mc;

    const holdSec = (now - trade.entryTs) / 1000;

    if (token.state === STATE.HOLDING) {
      transition(token, STATE.EXIT_UNLOCKED, `exits active`, log);
    }

    const exitResult = runExitGates(trade, token, isBuy, sol, holdSec, log);
    if (exitResult.exit) {
      if (exitResult.sellAll) {
        return closeTrade(token, mc, now, exitResult.reason, log);
      }
      return sellTranche(token, mc, now, exitResult, log);
    }

    return null;
  }

  // ── BUYING ─────────────────────────────────────────────────────
  if (token.state === STATE.BUYING) return null;

  // ── WATCHING ───────────────────────────────────────────────────
  if (token.state === STATE.WATCHING) {
    token.liveTrades = (token.liveTrades || 0) + 1;
    const totalKnown = (token.historyTrades || 0) + (token.liveTrades || 0);
    const minTrades  = (token.isSeeded || token.isNurseryGrad) ? 3 : 10;
    if (token.historyLoaded && totalKnown >= minTrades) {
      transition(token, STATE.INDEXED, `ready (hist:${token.historyTrades} live:${token.liveTrades})`, log);
    }
    return null;
  }

  // ── INDEXED ────────────────────────────────────────────────────
  if (token.state === STATE.INDEXED) {
    const fg = floorGate(token);
    if (fg.pass) {
      token.floorMc = token.sessionLow;
      transition(token, STATE.FLOORED, fg.reason, log);
    }
    return null;
  }

  // ── FLOORED ────────────────────────────────────────────────────
  if (token.state === STATE.FLOORED) {
    const fg = floorGate(token);
    if (!fg.pass) {
      transition(token, STATE.INDEXED, `floor lost: ${fg.reason}`, log);
      return null;
    }
    token.floorMc = token.sessionLow;

    const floor      = token.sessionLow;
    const aboveFloor = (mc - floor) / floor;
    const isProven   = (token.winCount || 0) >= 1;
    const hasRealPump = isProven || token.sessionHigh >= floor * ARM_MIN_ATH_MULT;

    if (token.jitoBundle) {
      const round2Ready = token.sessionHigh > floor * ROUND2_PUMP_MULT;
      if (!round2Ready) return null;
    }

    if (!isProven && !token.isNurseryGrad && (token.floorTouches || 0) < 5) {
      const totalKnownArm = (token.historyTrades || 0) + (token.liveTrades || 0);
      if (totalKnownArm < HISTORY_MIN_TRADES) return null;
    }

    if (aboveFloor <= FLOOR_ARM_ZONE_PCT && mc > floor * 0.85 && hasRealPump && mc >= ENTRY_MC_MIN) {
      token.armedAt = nowSec;
      token.confirmedFloorTouches = Math.max(token.historyFloorTouches || 0, token.floorTouches || 0);
      const r2 = token.jitoBundle ? ' [ROUND-2]' : '';
      transition(token, STATE.ARMED, `arm zone: ${(aboveFloor*100).toFixed(1)}% above $${floor.toFixed(0)}${r2}`, log);
      return { type: 'ARM', token };
    }

    return null;
  }

  // ── ARMED ──────────────────────────────────────────────────────
  if (token.state === STATE.ARMED) {
    if (nowSec - token.armedAt > ARM_TIMEOUT_SECS) {
      transition(token, STATE.FLOORED, `arm timeout (${ARM_TIMEOUT_SECS}s)`, log);
      return { type: 'DISARM', token };
    }

    const floor      = token.sessionLow;
    const aboveFloor = (mc - floor) / floor;
    if (aboveFloor > FLOOR_ARM_ZONE_PCT * 1.5) {
      transition(token, STATE.FLOORED, `price ${(aboveFloor*100).toFixed(1)}% above floor — disarming`, log);
      return { type: 'DISARM', token };
    }

    if (mc < ENTRY_MC_MIN) {
      transition(token, STATE.FLOORED, `MC $${mc.toFixed(0)} < $${ENTRY_MC_MIN}`, log);
      return { type: 'DISARM', token };
    }

    if (process.env.REAL_TRADING === 'true' && !isLaser) return null;

    const entryResult = runEntryGates(token, isBuy, sol, mc, openCount, log);
    if (!entryResult.pass) {
      token.lastGateFail = `${entryResult.gate}: ${entryResult.reason}`;
      return null;
    }

    token.proven = true;
    transition(token, STATE.BUYING, 'all entry gates passed', log);
    return { type: 'OPEN_TRADE', token };
  }

  // ── CLOSED ─────────────────────────────────────────────────────
  if (token.state === STATE.CLOSED) {
    if (nowSec < token.cooldownUntil) return null;
    if (token.tradeCount >= MAX_TRADES_PER_TOKEN) {
      transition(token, STATE.BLACKLISTED, `trade cap (${token.tradeCount})`, log);
      return null;
    }
    const closedFloor = token.sessionLow || 0;
    const closedAbove = closedFloor > 0 ? (mc - closedFloor) / closedFloor : 1;
    if (closedAbove <= FLOOR_ARM_ZONE_PCT && mc >= ENTRY_MC_MIN && closedFloor > 0) {
      token.armedAt = nowSec;
      transition(token, STATE.ARMED, `re-armed (${(closedAbove*100).toFixed(1)}% above $${closedFloor.toFixed(0)})`, log);
      return { type: 'ARM', token };
    }
    transition(token, STATE.FLOORED, 'cooldown expired', log);
    return null;
  }

  return null;
}

// ── Confirm buy ──────────────────────────────────────────────────
export function confirmBuy(token, entryMc, buySignature, tokensReceived, log) {
  if (token.state !== STATE.BUYING) {
    log('WARN', token.symbol, token.mint, { msg: `confirmBuy in wrong state: ${token.state}` });
    return null;
  }

  const now = Date.now();

  // ── Classify trade mode: QUICK vs HOLD ──────────────────────
  const floor = token.sessionLow || entryMc;
  const ath   = token.sessionHigh || 0;
  const athFloorRatio = floor > 0 ? ath / floor : 0;
  const touches = Math.max(token.floorTouches || 0, token.historyFloorTouches || 0, token.confirmedFloorTouches || 0);
  const ticks   = (token.mcHistory || []).length;

  const isStrong = touches >= STRONG_MIN_FLOOR_TOUCHES
                && athFloorRatio >= STRONG_MIN_ATH_MULT
                && ticks >= STRONG_MIN_TICKS;

  const mode = isStrong ? 'HOLD' : 'QUICK';

  token.activeTrade = {
    id:            `${token.mint.slice(0,6)}_${token.tradeCount + 1}`,
    mode,
    entryMc,
    entryTs:       now,
    entryFloor:    floor,
    peakMc:        entryMc,
    currentMc:     entryMc,
    buySignature,
    tokensReceived,
    buyVol:        0,
    sellVol:       0,
    totalVol:      0,
    tickCount:     0,

    tranchesSold:  0,
    soldPct:       0,
    partialSells:  [],
    positionSol:   POSITION_SOL,
    remainingSol:  POSITION_SOL,
  };

  token.tradeCount++;
  transition(token, STATE.HOLDING,
    `[${mode}] buy at $${entryMc.toFixed(0)} (floor $${floor.toFixed(0)}, ath/floor=${athFloorRatio.toFixed(1)}x, touches=${touches})`, log);
  log('TRADE_OPEN', token.symbol, token.mint, {
    mode,
    entryMc: Math.round(entryMc),
    entryFloor: Math.round(floor),
    athFloorRatio: +athFloorRatio.toFixed(1),
    touches,
    ticks,
    sig: buySignature?.slice(0,12),
    tradeId: token.activeTrade.id,
  });

  return token.activeTrade;
}

// ── Sell one DCA tranche ─────────────────────────────────────────
function sellTranche(token, mc, now, exitResult, log) {
  const trade = token.activeTrade;
  if (!trade) return null;

  const tranche   = exitResult.tranche;
  const pctToSell = exitResult.pct;
  const solToSell = trade.positionSol * pctToSell;
  const pnlPct    = (mc - trade.entryMc) / trade.entryMc * 100;

  const partial = {
    tranche,
    pct: pctToSell,
    mc,
    ts: now,
    pnlPct: +(pnlPct - TRADE_FEE_PCT * 100).toFixed(2),
    solSold: +solToSell.toFixed(4),
  };

  trade.partialSells.push(partial);
  trade.tranchesSold = tranche;
  trade.soldPct     += pctToSell;
  trade.remainingSol = +(trade.remainingSol - solToSell).toFixed(4);

  log('DCA_SELL', token.symbol, token.mint, {
    tranche,
    pct: +(pctToSell * 100).toFixed(0),
    mc: Math.round(mc),
    entryMc: Math.round(trade.entryMc),
    pnlPct: partial.pnlPct,
    solSold: partial.solSold,
    remaining: trade.remainingSol,
    mult: +(mc / trade.entryMc).toFixed(2),
  });

  // If all 4 tranches sold, close the trade
  if (trade.tranchesSold >= 4 || trade.remainingSol <= 0.001) {
    return closeTradeFull(token, mc, now, 'DCA_COMPLETE', log);
  }

  // Still holding remaining position — emit partial sell event for runner
  return { type: 'PARTIAL_SELL', token, trade, partial };
}

// ── Close trade (full exit) ──────────────────────────────────────
function closeTrade(token, mc, now, reason, log) {
  return closeTradeFull(token, mc, now, reason, log);
}

function closeTradeFull(token, mc, now, reason, log) {
  const trade   = token.activeTrade;
  if (!trade) return null;
  const holdSec = (now - trade.entryTs) / 1000;

  // Calculate blended PnL from partial sells + remaining position
  let totalReturn = 0;
  for (const p of trade.partialSells) {
    totalReturn += p.solSold * (1 + p.pnlPct / 100);
  }
  // Remaining unsold position exits at current MC
  const remainPnlPct = (mc - trade.entryMc) / trade.entryMc * 100 - (TRADE_FEE_PCT * 100);
  totalReturn += trade.remainingSol * (1 + remainPnlPct / 100);
  const blendedPnl = ((totalReturn / trade.positionSol) - 1) * 100;

  const record = {
    ...trade,
    exitMc:       mc,
    exitTs:       now,
    holdSec,
    pnlPct:       +blendedPnl.toFixed(2),
    reason,
    partialSells: [...trade.partialSells],
    tranchesSold: trade.tranchesSold,
  };

  token.closedTrades.push(record);
  token.activeTrade  = null;
  token.lastExitMc   = mc;

  if (blendedPnl > 0) token.winCount = (token.winCount || 0) + 1;

  // Token health check — prevent overtrading on losers
  const totalTrades = token.closedTrades.length;
  const totalWins   = token.closedTrades.filter(t => t.pnlPct > 0).length;
  const tokenWR     = totalTrades > 0 ? totalWins / totalTrades : 1;

  if (totalTrades >= 4 && tokenWR < 0.25) {
    token.cooldownUntil = now / 1000 + 600;
    log('TOKEN_SICK', token.symbol, token.mint, {
      wr: +(tokenWR * 100).toFixed(0), trades: totalTrades, wins: totalWins,
      action: 'cooldown 10min',
    });
  } else if (reason === 'SELLER_EXIT') {
    token.cooldownUntil = now / 1000 + 30;   // fast re-arm — floor might hold next time
  } else if (reason === 'QUICK_STOP' || reason === 'HOLD_STOP' || reason === 'STOP_LOSS') {
    token.cooldownUntil = now / 1000 + 120;
  } else {
    token.cooldownUntil = now / 1000 + REENTRY_COOLDOWN_SECS;
  }

  const modeTag = trade.mode || '?';
  transition(token, STATE.CLOSED, `[${modeTag}] ${reason} at $${mc.toFixed(0)} (${blendedPnl > 0 ? '+' : ''}${blendedPnl.toFixed(1)}%) [${trade.tranchesSold}T sold]`, log);

  log('TRADE_CLOSE', token.symbol, token.mint, {
    tradeId:       record.id,
    entryMc:       Math.round(trade.entryMc),
    exitMc:        Math.round(mc),
    pnlPct:        +blendedPnl.toFixed(2),
    holdSec:       +holdSec.toFixed(1),
    reason,
    tranchesSold:  trade.tranchesSold,
    partialSells:  trade.partialSells.length,
    peakMult:      +(trade.peakMc / trade.entryMc).toFixed(2),
  });

  return { type: 'CLOSE_TRADE', token, trade: record, reason, exitMc: mc };
}

// ── Force close ──────────────────────────────────────────────────
export function forceClose(token, currentMc, log) {
  if (!token.activeTrade && token.state !== STATE.BUYING) return null;
  if (token.state === STATE.BUYING) {
    transition(token, STATE.CLOSED, 'emergency stop during buy', log);
    return { type: 'CLOSE_TRADE', token, trade: null, reason: 'EMERGENCY_STOP', exitMc: currentMc };
  }
  return closeTradeFull(token, currentMc || 4000, Date.now(), 'EMERGENCY_STOP', log);
}
