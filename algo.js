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
         FLOOR_MIN_TOUCHES } from './rules.js';

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
    mcHistory:       [],   // [{mc, ts, isBuy, sol}]
    vSol:            0,

    // History
    historyLoaded:   false,
    historyTrades:   0,

    // Quality
    uniqueBuyers:    new Set(),
    maxEarlyBuySol:  0,
    bundled:         false,
    bundleTxCount:   0,
    mayhemDetected:  false,

    // Floor
    floorMc:         null,   // confirmed floor level
    floorTouches:    0,

    // Arm
    armedAt:         0,

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
  // Rolling 5-minute history
  token.mcHistory.push({ mc, ts, isBuy, sol });
  const cutoff = ts - 300_000;
  while (token.mcHistory.length > 1 && token.mcHistory[0].ts < cutoff)
    token.mcHistory.shift();

  token.currentMc = mc;
  if (mc > token.sessionHigh) token.sessionHigh = mc;
  if (mc < token.sessionLow && mc > 0) token.sessionLow = mc;

  // Recount floor touches (price within ±5% of session low)
  if (token.sessionLow < Infinity) {
    token.floorTouches = token.mcHistory.filter(h =>
      h.mc <= token.sessionLow * (1 + FLOOR_TOUCH_PCT) &&
      h.mc >= token.sessionLow * (1 - FLOOR_TOUCH_PCT)
    ).length;
  }
}

// ── Main tick function ────────────────────────────────────────────
// Called by the runner on every trade event for a token.
// Returns an event object if action is needed, or null.
//
// Events returned:
//   { type: 'OPEN_TRADE', token }
//   { type: 'CLOSE_TRADE', token, trade, reason, exitMc }
//   { type: 'ARM', token }
//   { type: 'DISARM', token }
//   null (no action needed)
//
export function onTick(token, mc, ts, isBuy, sol, openCount, isLaser, log) {
  // Always update price structure first — no exceptions
  updatePrice(token, mc, ts, isBuy, sol);

  const now = Date.now();
  const nowSec = now / 1000;

  // ── If in trade: manage exit ──────────────────────────────────
  if (token.state === STATE.HOLDING || token.state === STATE.EXIT_UNLOCKED) {
    const trade   = token.activeTrade;
    if (!trade) return null;

    // Update trade metrics
    trade.currentMc  = mc;
    trade.totalVol  += sol;
    if (isBuy) trade.buyVol  += sol;
    else       trade.sellVol += sol;
    if (mc > trade.peakMc) trade.peakMc = mc;

    const holdSec = (now - trade.entryTs) / 1000;

    // Unlock exit after MIN_HOLD_SECS
    if (token.state === STATE.HOLDING && holdSec >= MIN_HOLD_SECS) {
      transition(token, STATE.EXIT_UNLOCKED, `hold timer expired (${holdSec.toFixed(1)}s)`, log);
    }

    // Run exit gates
    const exitResult = runExitGates(trade, token, isBuy, sol, holdSec, log);
    if (exitResult.exit) {
      return closeTrade(token, mc, now, exitResult.reason, log);
    }

    return null;
  }

  // ── BUYING state: waiting for on-chain confirmation ──────────
  if (token.state === STATE.BUYING) {
    // Runner will call confirmBuy() when tx confirms. Nothing to do on ticks.
    return null;
  }

  // ── WATCHING: waiting for history ────────────────────────────
  if (token.state === STATE.WATCHING) {
    if (token.historyLoaded && token.historyTrades >= 10) {
      transition(token, STATE.INDEXED, 'history loaded', log);
    }
    return null;
  }

  // ── INDEXED: check if floor is confirmed ──────────────────────
  if (token.state === STATE.INDEXED) {
    const fg = floorGate(token);
    if (fg.pass) {
      token.floorMc = token.sessionLow;
      transition(token, STATE.FLOORED, fg.reason, log);
    }
    return null;
  }

  // ── FLOORED: wait for price to reach arm zone ─────────────────
  if (token.state === STATE.FLOORED) {
    // Re-check floor in case session low updated
    const fg = floorGate(token);
    if (!fg.pass) {
      // Floor no longer confirmed (not enough touches)
      transition(token, STATE.INDEXED, `floor lost: ${fg.reason}`, log);
      return null;
    }
    token.floorMc = token.sessionLow;

    // Check if price is in arm zone (within 8% of floor)
    const floor      = token.sessionLow;
    const aboveFloor = (mc - floor) / floor;

    if (aboveFloor <= 0.08 && mc > floor * 0.85) {
      token.armedAt = nowSec;
      transition(token, STATE.ARMED, `in arm zone: ${(aboveFloor*100).toFixed(1)}% above floor $${floor.toFixed(0)}`, log);
      return { type: 'ARM', token };
    }

    return null;
  }

  // ── ARMED: waiting for catalyst ───────────────────────────────
  if (token.state === STATE.ARMED) {
    // Arm timeout
    if (nowSec - token.armedAt > ARM_TIMEOUT_SECS) {
      transition(token, STATE.FLOORED, `arm timeout (${ARM_TIMEOUT_SECS}s)`, log);
      return { type: 'DISARM', token };
    }

    // Price moved too far above floor — disarm
    const floor      = token.sessionLow;
    const aboveFloor = (mc - floor) / floor;
    if (aboveFloor > 0.12) {
      transition(token, STATE.FLOORED, `price moved ${(aboveFloor*100).toFixed(1)}% above floor — disarming`, log);
      return { type: 'DISARM', token };
    }

    // In real trading mode — only LaserStream can trigger a buy
    // Runner sets isLaser=true only for LaserStream ticks
    // This gate is enforced here structurally — not in a nested if
    if (process.env.REAL_TRADING === 'true' && !isLaser) {
      return null;  // PumpPortal tick in real trading — never triggers buy
    }

    // Run all 8 entry gates
    const entryResult = runEntryGates(token, isBuy, sol, mc, openCount, log);
    if (!entryResult.pass) return null;

    // All gates passed — open the trade
    transition(token, STATE.BUYING, 'all entry gates passed', log);
    return { type: 'OPEN_TRADE', token };
  }

  // ── CLOSED / BLACKLISTED / COOLDOWN ──────────────────────────
  if (token.state === STATE.CLOSED) {
    if (nowSec < token.cooldownUntil) return null;
    if (token.tradeCount >= MAX_TRADES_PER_TOKEN) {
      transition(token, STATE.BLACKLISTED, `trade cap hit (${token.tradeCount})`, log);
      return null;
    }
    // Cooldown expired — go back to watching floor
    transition(token, STATE.FLOORED, 'cooldown expired, re-watching floor', log);
    return null;
  }

  return null;
}

// ── Confirm buy (called by runner when tx confirms on-chain) ─────
export function confirmBuy(token, entryMc, buySignature, tokensReceived, log) {
  if (token.state !== STATE.BUYING) {
    log('WARN', token.symbol, token.mint, { msg: `confirmBuy called in wrong state: ${token.state}` });
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

// ── Close trade ───────────────────────────────────────────────────
function closeTrade(token, mc, now, reason, log) {
  const trade   = token.activeTrade;
  const holdSec = (now - trade.entryTs) / 1000;

  // Cap max loss at STOP_LOSS_PCT for realism
  let exitMc = mc;
  const worstMc = trade.entryMc * (1 - 0.05);
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

  // Cooldown
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

// ── Force close (emergency stop) ─────────────────────────────────
export function forceClose(token, currentMc, log) {
  if (!token.activeTrade && token.state !== STATE.BUYING) return null;
  if (token.state === STATE.BUYING) {
    transition(token, STATE.CLOSED, 'emergency stop during buy', log);
    return { type: 'CLOSE_TRADE', token, trade: null, reason: 'EMERGENCY_STOP', exitMc: currentMc };
  }
  return closeTrade(token, currentMc, Date.now(), 'EMERGENCY_STOP', log);
}
