/**
 * algo.js — STATE MACHINE ENGINE
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
 * The runner handles all I/O. The algo handles all decisions.
 * They communicate through clean interfaces. No leaking.
 */

import { STATE, MIN_HOLD_SECS, REENTRY_COOLDOWN_SECS,
         ARM_TIMEOUT_SECS, TRADE_FEE_PCT, POSITION_SOL,
         MAX_TRADES_PER_TOKEN, FLOOR_TOUCH_PCT,
         FLOOR_ARM_ZONE_PCT, UNLOCK_MC_USD, STOP_LOSS_PCT,
         ENTRY_MC_MIN, ROUND2_PUMP_MULT,
         JITO_ROUND2_MIN_ATH, HISTORY_MIN_TRADES } from './rules.js';

import { runEntryGates, runExitGates, floorGate } from './gates.js';

// ── Token factory ────────────────────────────────────────────────
export function makeToken(mint, symbol, name, category) {
  return {
    mint, symbol, name, category,

    // State machine
    state:           STATE.WATCHING,
    stateChangedAt:  Date.now(),

    // Price structure
    currentMc:       0,
    sessionHigh:     0,
    sessionLow:      Infinity,
    mcHistory:       [],
    vSol:            0,
    prevMcSol:       0,

    // History
    historyLoaded:   false,
    historyTrades:   0,
    liveTrades:      0,

    // Quality
    uniqueBuyers:    new Set(),
    maxEarlyBuySol:  0,
    mayhemDetected:  false,

    // Jito bundle detection (replaces old heuristic)
    jitoBundle:      false,
    jitoBundleSlot:  null,
    bundlePeakMc:    0,

    // Floor
    floorMc:         null,
    floorTouches:    0,

    // Arm
    armedAt:         0,

    // Proven flag — never prune if true
    proven:          false,

    // Trade tracking
    activeTrade:     null,
    lastExitMc:      null,
    cooldownUntil:   0,
    blacklistedUntil:0,
    tradeCount:      0,
    closedTrades:    [],
  };
}

// ── State transition — always logged, always explicit ────────────
function transition(token, newState, reason, log) {
  const oldState = token.state;
  token.state          = newState;
  token.stateChangedAt = Date.now();
  log('STATE', token.symbol, token.mint, {
    from: oldState, to: newState, reason,
    mc: Math.round(token.currentMc),
  });
}

// ── Price structure update ────────────────────────────────────────
export function updatePrice(token, mc, ts, isBuy, sol) {
  token.mcHistory.push({ mc, ts, isBuy, sol });
  const cutoff = ts - 300_000;
  while (token.mcHistory.length > 1 && token.mcHistory[0].ts < cutoff)
    token.mcHistory.shift();

  token.currentMc  = mc;
  token.lastTickTs = ts;
  if (mc > token.sessionHigh) token.sessionHigh = mc;
  if (mc < token.sessionLow && mc > 0) token.sessionLow = mc;

  if (token.sessionLow < Infinity) {
    token.floorTouches = token.mcHistory.filter(h =>
      h.mc <= token.sessionLow * (1 + FLOOR_TOUCH_PCT) &&
      h.mc >= token.sessionLow * (1 - FLOOR_TOUCH_PCT)
    ).length;
  }
}

// ── Jito bundle price reset ──────────────────────────────────────
// Called by runner after same-slot detection confirms a Jito bundle.
// Wipes the bundler's price data so round-2 floor detection is clean.
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

// ── Main tick function ────────────────────────────────────────────
export function onTick(token, mc, ts, isBuy, sol, openCount, isLaser, log) {
  updatePrice(token, mc, ts, isBuy, sol);

  const now = Date.now();
  const nowSec = now / 1000;

  // ══════════════════════════════════════════════════════════════
  // FIREWALL — mayhem agent only. Jito bundles are NOT blacklisted
  // here; they follow the round-2 path instead.
  // ══════════════════════════════════════════════════════════════
  if (token.state !== STATE.BLACKLISTED && token.state !== STATE.CLOSED) {
    if (token.mayhemDetected) {
      transition(token, STATE.BLACKLISTED, `FIREWALL: mayhem agent detected`, log);
      return token.state === STATE.ARMED ? { type: 'DISARM', token } : null;
    }
    // Jito bundle with ATH too low to be worth round-2
    if (token.jitoBundle && (token.bundlePeakMc || 0) < JITO_ROUND2_MIN_ATH && token.bundlePeakMc > 0) {
      transition(token, STATE.BLACKLISTED, `FIREWALL: jito bundle + ATH $${Math.round(token.bundlePeakMc)} < $${JITO_ROUND2_MIN_ATH}`, log);
      return token.state === STATE.ARMED ? { type: 'DISARM', token } : null;
    }
  }

  // ── If in trade: manage exit ──────────────────────────────────
  if (token.state === STATE.HOLDING || token.state === STATE.EXIT_UNLOCKED) {
    const trade   = token.activeTrade;
    if (!trade) return null;

    trade.currentMc  = mc;
    trade.totalVol  += sol;
    trade.tickCount  = (trade.tickCount || 0) + 1;
    if (isBuy) trade.buyVol  += sol;
    else       trade.sellVol += sol;
    if (mc > trade.peakMc) trade.peakMc = mc;

    const holdSec = (now - trade.entryTs) / 1000;

    if (token.state === STATE.HOLDING) {
      transition(token, STATE.EXIT_UNLOCKED, `order-flow mode: exit gates active immediately`, log);
    }

    if (trade.buyVol === 0 && (trade.tickCount >= 5 || holdSec >= 10)) {
      log('EXIT_GATE', token.symbol, token.mint, { gate: 'NO_FOLLOWTHROUGH', ticks: trade.tickCount, holdSec: holdSec.toFixed(1) });
      return closeTrade(token, mc, now, 'NO_FOLLOWTHROUGH', log);
    }

    const exitResult = runExitGates(trade, token, isBuy, sol, holdSec, log);
    if (exitResult.exit) {
      return closeTrade(token, mc, now, exitResult.reason, log);
    }

    return null;
  }

  // ── BUYING state ───────────────────────────────────────────────
  if (token.state === STATE.BUYING) {
    return null;
  }

  // ── WATCHING: waiting for history / enough data ────────────────
  if (token.state === STATE.WATCHING) {
    token.liveTrades = (token.liveTrades || 0) + 1;

    const totalKnown = (token.historyTrades || 0) + (token.liveTrades || 0);
    const minTrades  = token.isSeeded ? 3 : 10;
    if (token.historyLoaded && totalKnown >= minTrades) {
      transition(token, STATE.INDEXED, `ready (hist:${token.historyTrades} live:${token.liveTrades})`, log);
    }
    return null;
  }

  // ── INDEXED: check if floor is confirmed ───────────────────────
  if (token.state === STATE.INDEXED) {
    const fg = floorGate(token);
    if (fg.pass) {
      token.floorMc = token.sessionLow;
      transition(token, STATE.FLOORED, fg.reason, log);
    }
    return null;
  }

  // ── FLOORED: wait for price to reach arm zone ──────────────────
  if (token.state === STATE.FLOORED) {
    const fg = floorGate(token);
    if (!fg.pass) {
      transition(token, STATE.INDEXED, `floor lost: ${fg.reason}`, log);
      return null;
    }
    token.floorMc = token.sessionLow;

    const floor      = token.sessionLow;
    const aboveFloor = (mc - floor) / floor;

    const hasRealPump = token.sessionHigh > floor * 1.50;

    // Round-2 gate for Jito bundles: must have a second organic pump
    // sessionHigh > floor × ROUND2_PUMP_MULT proves organic demand after bundler dump
    if (token.jitoBundle) {
      const round2Ready = token.sessionHigh > floor * ROUND2_PUMP_MULT;
      if (!round2Ready) return null;
    }

    // Pre-arm history check: must meet trade threshold before arming
    const totalKnownArm = (token.historyTrades || 0) + (token.liveTrades || 0);
    if (totalKnownArm < HISTORY_MIN_TRADES) return null;

    if (aboveFloor <= FLOOR_ARM_ZONE_PCT && mc > floor * 0.85 && hasRealPump && mc >= ENTRY_MC_MIN) {
      token.armedAt = nowSec;
      token.confirmedFloorTouches = Math.max(
        token.historyFloorTouches || 0,
        token.floorTouches || 0
      );
      const r2 = token.jitoBundle ? ' [ROUND-2]' : '';
      transition(token, STATE.ARMED, `in arm zone: ${(aboveFloor*100).toFixed(1)}% above floor $${floor.toFixed(0)} (high $${token.sessionHigh.toFixed(0)})${r2}`, log);
      return { type: 'ARM', token };
    }

    return null;
  }

  // ── ARMED: waiting for catalyst ────────────────────────────────
  if (token.state === STATE.ARMED) {
    if (nowSec - token.armedAt > ARM_TIMEOUT_SECS) {
      transition(token, STATE.FLOORED, `arm timeout (${ARM_TIMEOUT_SECS}s)`, log);
      return { type: 'DISARM', token };
    }

    const floor      = token.sessionLow;
    const aboveFloor = (mc - floor) / floor;
    if (aboveFloor > FLOOR_ARM_ZONE_PCT * 1.5) {
      transition(token, STATE.FLOORED, `price moved ${(aboveFloor*100).toFixed(1)}% above floor — disarming`, log);
      return { type: 'DISARM', token };
    }

    if (mc < ENTRY_MC_MIN) {
      transition(token, STATE.FLOORED, `MC $${mc.toFixed(0)} dropped below min $${ENTRY_MC_MIN}`, log);
      return { type: 'DISARM', token };
    }

    if (process.env.REAL_TRADING === 'true' && !isLaser) {
      return null;
    }

    const entryResult = runEntryGates(token, isBuy, sol, mc, openCount, log);
    if (!entryResult.pass) {
      token.lastGateFail = `${entryResult.gate}: ${entryResult.reason}`;
      return null;
    }

    token.proven = true;
    transition(token, STATE.BUYING, 'all entry gates passed', log);
    return { type: 'OPEN_TRADE', token };
  }

  // ── CLOSED / BLACKLISTED / COOLDOWN ────────────────────────────
  if (token.state === STATE.CLOSED) {
    if (nowSec < token.cooldownUntil) return null;
    if (token.tradeCount >= MAX_TRADES_PER_TOKEN) {
      transition(token, STATE.BLACKLISTED, `trade cap hit (${token.tradeCount})`, log);
      return null;
    }
    transition(token, STATE.FLOORED, 'cooldown expired, re-watching floor', log);
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
  token.activeTrade = {
    id:            `${token.mint.slice(0,6)}_${token.tradeCount + 1}`,
    entryMc,
    entryTs:       now,
    peakMc:        entryMc,
    currentMc:     entryMc,
    buySignature,
    tokensReceived,
    buyVol:        0,
    sellVol:       0,
    totalVol:      0,
  };

  token.tradeCount++;
  transition(token, STATE.HOLDING, `buy confirmed at $${entryMc.toFixed(0)}`, log);
  log('TRADE_OPEN', token.symbol, token.mint, {
    entryMc: Math.round(entryMc), sig: buySignature?.slice(0,12),
    tradeId: token.activeTrade.id,
  });

  return token.activeTrade;
}

// ── Close trade ──────────────────────────────────────────────────
function closeTrade(token, mc, now, reason, log) {
  const trade   = token.activeTrade;
  const holdSec = (now - trade.entryTs) / 1000;

  let exitMc = mc;
  const worstMc = trade.entryMc * (1 - STOP_LOSS_PCT / 100);
  if (exitMc < worstMc) exitMc = worstMc;

  const pnlRaw = (exitMc - trade.entryMc) / trade.entryMc * 100;
  const pnl    = pnlRaw - (TRADE_FEE_PCT * 100);

  const record = {
    ...trade,
    exitMc,
    exitTs:  now,
    holdSec,
    pnlPct:  pnl,
    reason,
  };

  token.closedTrades.push(record);
  token.activeTrade  = null;
  token.lastExitMc   = exitMc;

  const baseCooldown = reason === 'STOP_LOSS' || reason === 'CONVICTION_FADE'
    ? 120 : REENTRY_COOLDOWN_SECS;
  token.cooldownUntil = now / 1000 + baseCooldown;

  transition(token, STATE.CLOSED, `${reason} at $${exitMc.toFixed(0)} (${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}%)`, log);

  log('TRADE_CLOSE', token.symbol, token.mint, {
    tradeId:  record.id,
    entryMc:  Math.round(trade.entryMc),
    exitMc:   Math.round(exitMc),
    pnlPct:   +pnl.toFixed(2),
    holdSec:  +holdSec.toFixed(1),
    reason,
  });

  return { type: 'CLOSE_TRADE', token, trade: record, reason, exitMc };
}

// ── Force close (emergency / watchdog / restart) ─────────────────
export function forceClose(token, currentMc, log) {
  if (!token.activeTrade && token.state !== STATE.BUYING) return null;
  if (token.state === STATE.BUYING) {
    transition(token, STATE.CLOSED, 'emergency stop during buy', log);
    return { type: 'CLOSE_TRADE', token, trade: null, reason: 'EMERGENCY_STOP', exitMc: currentMc };
  }
  return closeTrade(token, currentMc || 4000, Date.now(), 'EMERGENCY_STOP', log);
}
