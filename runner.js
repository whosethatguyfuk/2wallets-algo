/**
 * runner.js — I/O LAYER (v2.0)
 *
 * Handles everything external:
 *   - PumpPortal WebSocket (discovery + order book)
 *   - Helius (Jito bundle detection via same-slot, history for seeded coins)
 *   - LaserStream (armed token feeds)
 *   - Nursery (lightweight new-token tracking)
 *   - Cold-watch (evicted nursery tokens still subscribed)
 *   - Disk persistence (survive restarts)
 *   - Express dashboard
 */

import express      from 'express';
import { createServer } from 'http';
import WebSocket    from 'ws';
import fetch        from 'node-fetch';
import fs           from 'fs';
import path         from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Crash guards ─────────────────────────────────────────────────
process.on('unhandledRejection', r => console.error('⚠️  unhandledRejection:', r?.message ?? r));
process.on('uncaughtException',  e => console.error('⚠️  uncaughtException:', e.message));

// ── Config ───────────────────────────────────────────────────────
const PORT          = Number(process.env.PORT) || 2500;
const REAL_TRADING  = process.env.REAL_TRADING === 'true';
const HELIUS_KEY    = process.env.HELIUS_API_KEY;
const AUTH_TOKEN    = process.env.API_AUTH_TOKEN || '';
const HELIUS_RPC    = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const PP_WS_URL     = 'wss://pumpportal.fun/api/data';

// ── Import algo ──────────────────────────────────────────────────
import { makeToken, onTick, confirmBuy, forceClose, updatePrice, applyJitoBundleReset } from './algo.js';
import { runEntryGates, floorGate } from './gates.js';
import {
  QUALITY_MC_THRESHOLD, QUALITY_MAX_BUY_SOL,
  MAYHEM_AGENT_WALLET, STATE, POSITION_SOL, MAX_HOLD_SECS,
  NURSERY_MAX, NURSERY_PURGE_MS, NURSERY_MIN_TRADERS,
  COLD_PROMOTE_MC, JITO_SAME_SLOT_BUYS, JITO_SAME_SLOT_WALLETS,
  MC_DIRECTION_MIN_DELTA, CATALYST_MIN_SOL,
  MAX_SOL_PER_TICK, MAX_MC_CHANGE_PCT, MC_BONDING_CURVE_MAX,
  PENDING_TIMEOUT_MS, TRADE_FEE_PCT,
  SNAPSHOT_INTERVAL_MS, RESUB_BATCH_SIZE, RESUB_BATCH_DELAY_MS,
} from './rules.js';

// ── Real trading imports ─────────────────────────────────────────
let executeBuy, executeSell, armForMint, disarmMint, openLaserStream, getSolBalance, initWallet;
if (REAL_TRADING) {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error('REAL_TRADING=true but WALLET_PRIVATE_KEY missing');
  if (!HELIUS_KEY)                      throw new Error('REAL_TRADING=true but HELIUS_API_KEY missing');
  const exec  = await import('../alligator2.4/executor.js');
  const laser = await import('../alligator2.4/laserstream.js');
  executeBuy      = exec.executeBuy;
  executeSell     = exec.executeSell;
  armForMint      = exec.armForMint;
  disarmMint      = exec.disarmMint;
  openLaserStream = laser.openLaserStream;
  getSolBalance   = exec.getSolBalance;
  initWallet      = exec.initWallet;
  const addr = initWallet(process.env.WALLET_PRIVATE_KEY);
  console.log(`💳 REAL TRADING — wallet: ${addr}`);
}

// ── State ────────────────────────────────────────────────────────
const registry   = new Map();    // mint → token (full, promoted)
const nursery    = new Map();    // mint → lightweight nursery object
const coldWatch  = new Set();    // mints evicted from nursery, still subscribed
const laserSlots = new Map();    // mint → cancel()
let   tradingHalted = process.env.START_HALTED === 'true';
let   openCount     = 0;
let   totalWins     = 0;
let   totalLosses   = 0;
let   totalFeesSol  = 0;
let   netPnlSol     = 0;
let   realWalletSol = null;
let   startingSol   = null;

// ── Tracked wallets — detect their trades on our coins ─────────
const TRACKED_WALLETS = new Map([
  ['FYTVwP5hgCUiB14eYYTPtZpBCBL4tqbYFbRkjmRwbNto', 'Wallet-A'],
  ['FLh66qAJLTgNepSET1FCQUqQR7SbuJGF5jRPqCg3kGEd', 'Wallet-B'],
]);
// Per-mint trade log: { mint → { walletTrades: [{ts, wallet, isBuy, sol, mc}], ourTrades: [{ts, isBuy, sol, mc, pnl}] } }
const walletComparisons = new Map();
let   solPrice      = 150;
let   ppWs          = null;
let   ppReady       = false;
let   watchdogRuns  = 0;
let   watchdogKills = 0;
let   nurseryTotal  = 0;
const sseClients    = new Set();
const pendingBuys   = new Map();   // mint → { token, triggerMc, ticksLeft }
const pendingSells  = new Map();   // mint → { token, trade, reason, triggerExitMc, ticksLeft }

// ── Logging ──────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, `run_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.jsonl`);
fs.mkdirSync(DATA_DIR, { recursive: true });

function log(type, symbol, mint, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, symbol, mint, ...extra });
  fs.appendFileSync(LOG_FILE, line + '\n');
  if (type !== 'EXIT_BLOCKED' && type !== 'GATE_FAIL') console.log(line);
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of sseClients) { try { c.write(`data: ${msg}\n\n`); } catch {} }
}

// ── Helius: same-slot Jito bundle detection ──────────────────────
const PUMP_PROGRAM_ID   = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_TOTAL_SUPPLY = 1_073_000_191;

async function checkJitoBundle(token) {
  if (!HELIUS_KEY) return false;
  try {
    const sigRes = await fetch(HELIUS_RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'getSignaturesForAddress',
        params:  [token.mint, { limit: 20 }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const sigData = await sigRes.json();
    const sigs = (sigData.result || []);

    if (sigs.length === 0) return false;

    // Sigs come newest-first. For new tokens this IS the launch.
    // For old tokens we need the oldest sigs — reverse and take first 15.
    const sorted = [...sigs].reverse();
    const earlySignatures = sorted.slice(0, 15).map(s => s.signature).filter(Boolean);

    if (earlySignatures.length === 0) return false;

    const txRes = await fetch(
      `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transactions: earlySignatures }),
        signal:  AbortSignal.timeout(15_000),
      }
    );
    if (!txRes.ok) return false;
    const txs = await txRes.json();
    if (!Array.isArray(txs)) return false;

    // Find the create transaction's slot (earliest slot number)
    const slots = txs.map(tx => tx.slot).filter(Boolean);
    if (slots.length === 0) return false;
    const createSlot = Math.min(...slots);

    // Count buys in the create slot from different wallets
    const createSlotBuys = [];
    for (const tx of txs) {
      if (tx.slot !== createSlot) continue;
      if (tx.transactionError) continue;
      const tt = tx.tokenTransfers || [];
      const tokOut = tt.find(t => t.mint === token.mint);
      if (!tokOut) continue;
      const isBuy = tokOut.toUserAccount !== PUMP_PROGRAM_ID;
      if (!isBuy) continue;
      const trader = tokOut.toUserAccount;
      createSlotBuys.push(trader);
    }

    const uniqueWallets = new Set(createSlotBuys.filter(Boolean));
    const isBundled = createSlotBuys.length >= JITO_SAME_SLOT_BUYS
                   && uniqueWallets.size >= JITO_SAME_SLOT_WALLETS;

    if (isBundled) {
      log('JITO_BUNDLE', token.symbol, token.mint, {
        slot: createSlot,
        buys: createSlotBuys.length,
        wallets: uniqueWallets.size,
      });
    }

    return isBundled;
  } catch (e) {
    log('JITO_CHECK_FAIL', token.symbol, token.mint, { error: e.message });
    return false;
  }
}

// ── Helius: load history (seeded old coins only) ─────────────────
async function loadHistory(token) {
  if (!HELIUS_KEY) {
    token.historyLoaded = true;
    token.historyTrades = 0;
    return;
  }

  try {
    const sigRes = await fetch(HELIUS_RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'getSignaturesForAddress',
        params:  [token.mint, { limit: 150 }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const sigData = await sigRes.json();
    const sigs = (sigData.result || []).map(s => s.signature).filter(Boolean);

    if (sigs.length === 0) {
      token.historyLoaded = true;
      token.historyTrades = 0;
      return;
    }

    const txRes = await fetch(
      `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transactions: sigs.slice(0, 100) }),
        signal:  AbortSignal.timeout(15_000),
      }
    );
    if (!txRes.ok) { return; }
    const txs = await txRes.json();
    if (!Array.isArray(txs)) { return; }

    const allTrades = [];
    const historyBuyers = new Set();

    for (const tx of txs) {
      if (tx.transactionError) continue;
      if (tx.source !== 'PUMP_FUN' && tx.type !== 'SWAP') continue;

      const tt  = tx.tokenTransfers || [];
      const nt  = tx.nativeTransfers || [];
      const tokOut = tt.find(t => t.mint === token.mint);
      if (!tokOut) continue;

      const tokAmt = tokOut.tokenAmount || 0;
      if (tokAmt <= 0) continue;

      const solAmt = Math.max(...nt.map(n => (n.amount || 0)), 0) / 1e9;
      if (solAmt <= 0) continue;

      const isBuy  = tokOut.toUserAccount !== PUMP_PROGRAM_ID;
      const trader = isBuy ? tokOut.toUserAccount : tokOut.fromUserAccount;
      const mcSol = (solAmt / tokAmt) * PUMP_TOTAL_SUPPLY;
      const mcUsd = mcSol * solPrice;
      if (mcUsd <= 0 || mcUsd > 500_000) continue;

      allTrades.push({ ts: (tx.timestamp || 0) * 1000, isBuy, sol: solAmt, mc: mcUsd, trader, slot: tx.slot });
    }

    allTrades.sort((a, b) => a.ts - b.ts);

    // Same-slot Jito detection from history
    if (allTrades.length >= 3) {
      const firstSlot = allTrades[0].slot || allTrades[0].ts;
      const slotBuys = allTrades.filter(t => t.isBuy && t.slot === firstSlot);
      const slotWallets = new Set(slotBuys.map(t => t.trader).filter(Boolean));
      if (slotBuys.length >= JITO_SAME_SLOT_BUYS && slotWallets.size >= JITO_SAME_SLOT_WALLETS) {
        applyJitoBundleReset(token, log);
      }
    }

    let count = 0;
    for (const { ts, isBuy, sol, mc, trader } of allTrades) {
      // Skip pre-reset ticks for bundled tokens (they're from the bundler)
      if (token.jitoBundle && count < 10) { count++; continue; }
      updatePrice(token, mc, ts || Date.now(), isBuy, sol);
      if (isBuy) {
        if (trader) historyBuyers.add(trader);
        if (mc < QUALITY_MC_THRESHOLD && sol > QUALITY_MAX_BUY_SOL) {
          token.maxEarlyBuySol = Math.max(token.maxEarlyBuySol, sol);
        }
      }
      count++;
    }

    if (token.sessionLow < Infinity && token.mcHistory.length > 0) {
      const floor = token.sessionLow;
      token.historyFloorTouches = token.mcHistory.filter(h =>
        h.mc <= floor * 1.08 && h.mc >= floor * 0.92
      ).length;
    }

    token.resolvedBuyerCount = Math.max(
      historyBuyers.size,
      token.uniqueBuyers?.size || 0
    );

    token.historyLoaded = true;
    token.historyTrades = count;
    log('HISTORY_LOADED', token.symbol, token.mint, {
      trades: count, jito: token.jitoBundle,
      sessionLow: Math.round(token.sessionLow || 0),
      floorTouches: token.historyFloorTouches,
      buyers: token.resolvedBuyerCount,
    });

    if (token.state === STATE.WATCHING) {
      const totalKnown = count + (token.liveTrades || 0);
      const refMc = token.currentMc > 0 ? token.currentMc
                  : token.sessionLow < Infinity ? token.sessionLow * 1.05 : 0;
      if (totalKnown >= 10 && refMc > 0) {
        const event = onTick(token, refMc, Date.now(), false, 0, openCount, false, log);
        handleEvent(event).catch(() => {});
      }
    }
  } catch (e) {
    log('HISTORY_FAIL', token.symbol, token.mint, { error: e.message });
  }
}

// ── Ensure token in registry (full token) ────────────────────────
async function ensureToken(mint, symbol, name, category) {
  if (registry.has(mint)) return registry.get(mint);
  const token = makeToken(mint, symbol || mint.slice(0,6), name || '', category || 'new');
  registry.set(mint, token);
  log('PROMOTED', token.symbol, mint, { category, fromNursery: nursery.has(mint) });
  return token;
}

// ── Nursery: promote survivors after purge ───────────────────────
async function promoteFromNursery(mint, nr) {
  const token = await ensureToken(mint, nr.symbol, nr.name, 'new');

  // Seed from nursery data
  token.sessionHigh = nr.ath;
  token.sessionLow  = nr.low < Infinity ? nr.low : Infinity;
  token.currentMc   = nr.currentMc;
  token.liveTrades  = nr.trades;
  // Only copy confirmed buyers, not all traders (which includes sellers)
  if (nr.uniqueBuyers) {
    for (const w of nr.uniqueBuyers) token.uniqueBuyers.add(w);
  }
  token.resolvedBuyerCount = nr.uniqueBuyers?.size || 0;

  // Jito check via Helius
  const isBundled = await checkJitoBundle(token);
  if (isBundled) {
    applyJitoBundleReset(token, log);
  }

  // We have live data from birth — mark history as loaded
  token.historyLoaded = true;
  token.historyTrades = nr.trades;
  token.isNurseryGrad = true;

  // Fetch ATH from pump.fun API to supplement our observation
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      const d = await r.json();
      const athMc = d.ath_market_cap || 0;
      if (athMc > token.sessionHigh && !token.jitoBundle) {
        token.sessionHigh = athMc;
      }
    }
  } catch {}

  // Kick state machine — nursery grads have complete data, always advance
  const event = onTick(token, token.currentMc || 4200, Date.now(), false, 0, openCount, false, log);
  if (event) handleEvent(event).catch(() => {});

  return token;
}

// ── Seed old coins ───────────────────────────────────────────────
async function seedOldCoins() {
  try {
    const urls = [
      'https://frontend-api-v3.pump.fun/coins?limit=50&sort=last_trade_timestamp&order=DESC',
      'https://frontend-api-v3.pump.fun/coins?limit=50&sort=last_reply&order=DESC',
      'https://frontend-api-v3.pump.fun/coins?limit=50&sort=market_cap&order=DESC',
      'https://frontend-api-v3.pump.fun/coins?limit=50&sort=currently_live&order=DESC',
    ];

    let seeded = 0;
    for (const url of urls) {
      let coins;
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) continue;
        coins = await r.json();
        if (!Array.isArray(coins)) continue;
      } catch { continue; }

      for (const c of coins) {
        const mint = c.mint;
        if (!mint || registry.has(mint) || nursery.has(mint)) continue;

        const vSol = (c.virtual_sol_reserves || 0) / 1e9;
        if (vSol > 85) continue;

        // Phantom MC filter: if real reserves are near zero, MC is fake
        const realSol = (c.real_sol_reserves || 0) / 1e9;
        if (realSol < 0.01 && (c.usd_market_cap || 0) > 10_000) continue;

        const athMc = c.ath_market_cap || c.usd_market_cap || 0;
        if (athMc < 8_000) continue;

        // Normalize timestamps: pump.fun uses ms for created_timestamp, ms for last_trade_timestamp
        const createdTs = c.created_timestamp || 0;
        const lastTradeTs = c.last_trade_timestamp || 0;
        // Both are in ms from pump.fun API
        const ageMs = Date.now() - createdTs;
        if (ageMs < 10 * 60_000) continue;

        const lastTradeAgeMs = Date.now() - lastTradeTs;
        if (lastTradeAgeMs > 6 * 60 * 60_000) continue;

        const token = await ensureToken(mint, c.symbol || mint.slice(0,6), c.name || '', 'old');
        token.isSeeded = true;
        token.vSol     = vSol;
        if (c.ath_market_cap && c.ath_market_cap > (token.sessionHigh || 0)) {
          token.sessionHigh = c.ath_market_cap;
        }

        if (ppWs && ppWs.readyState === 1) {
          ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        }

        // Load history for seeded coins (we missed their early ticks)
        loadHistory(token).catch(() => {});
        seeded++;

        if (seeded % 5 === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    if (seeded > 0) log('SEED', 'system', 'system', { seeded, totalRegistry: registry.size });
  } catch (e) {
    console.error('seedOldCoins error:', e.message);
  }
}

// ── Event handler ────────────────────────────────────────────────
async function handleEvent(event) {
  if (!event) return;

  if (event.type === 'ARM') {
    const token = event.token;
    broadcast({ type: 'arm', mint: token.mint, symbol: token.symbol, mc: Math.round(token.currentMc) });

    if (REAL_TRADING && armForMint) {
      try {
        const cancel = await armForMint(token.mint);
        laserSlots.set(token.mint, cancel);
      } catch (e) { log('ARM_FAIL', token.symbol, token.mint, { error: e.message }); }
    }
    return;
  }

  if (event.type === 'DISARM') {
    const token = event.token;
    broadcast({ type: 'disarm', mint: token.mint, symbol: token.symbol });
    if (laserSlots.has(token.mint)) {
      try { laserSlots.get(token.mint)(); } catch {}
      laserSlots.delete(token.mint);
    }
    return;
  }

  if (event.type === 'OPEN_TRADE') {
    const token = event.token;
    openCount++;
    const mc = token.currentMc;

    if (!REAL_TRADING) {
      const slippageTicks = 1 + Math.floor(Math.random() * 3); // 1-3 ticks delay
      log('SLIPPAGE_QUEUE_BUY', token.symbol, token.mint, { triggerMc: Math.round(mc), delayTicks: slippageTicks });
      pendingBuys.set(token.mint, { token, triggerMc: mc, ticksLeft: slippageTicks, queuedAt: Date.now() });
      return;
    }

    try {
      const result = await executeBuy(token.mint, POSITION_SOL);
      const entryMc = result.effectiveMc || mc;
      confirmBuy(token, entryMc, result.signature, result.tokensReceived, log);
      log('BUY_REAL', token.symbol, token.mint, { sig: result.signature?.slice(0,12), mc: Math.round(entryMc) });
      broadcast({ type: 'buy', mint: token.mint, symbol: token.symbol, mc: Math.round(entryMc) });
    } catch (e) {
      log('BUY_FAIL', token.symbol, token.mint, { error: e.message });
      token.state = STATE.FLOORED;
      openCount = Math.max(0, openCount - 1);
    }
    return;
  }

  // ── DCA partial sell ────────────────────────────────────────────
  if (event.type === 'PARTIAL_SELL') {
    const { token, trade, partial } = event;

    if (!walletComparisons.has(token.mint)) walletComparisons.set(token.mint, { walletTrades: [], ourTrades: [] });
    walletComparisons.get(token.mint).ourTrades.push({
      ts: Date.now(), isBuy: false, sol: partial.solSold,
      mc: Math.round(partial.mc), pnl: partial.pnlPct,
      reason: partial.tranche === 1 ? 'DCA_T1' : partial.tranche === 2 ? 'DCA_T2' : 'DCA_T3',
    });

    const solGain = partial.solSold * (partial.pnlPct / 100);
    netPnlSol += solGain;
    totalFeesSol += partial.solSold * TRADE_FEE_PCT;

    broadcast({
      type: 'dca_sell', mint: token.mint, symbol: token.symbol,
      tranche: partial.tranche, pct: +(partial.pct * 100).toFixed(0),
      mc: Math.round(partial.mc), pnl: partial.pnlPct,
      remaining: trade.remainingSol.toFixed(4),
      mult: +(partial.mc / trade.entryMc).toFixed(2),
    });

    if (REAL_TRADING) {
      const sellPct = partial.pct;
      retrySell(token.mint, token.symbol).then(result => {
        log('DCA_SELL_REAL', token.symbol, token.mint, {
          tranche: partial.tranche, sig: result.signature?.slice(0,12),
          solReceived: result.solReceived,
        });
      }).catch(e => {
        log('DCA_SELL_FAIL', token.symbol, token.mint, { tranche: partial.tranche, error: e.message });
      });
    }
    return;
  }

  // ── Full close (floor break, bond cap, max hold, DCA complete) ──
  if (event.type === 'CLOSE_TRADE') {
    const { token, trade, reason, exitMc } = event;

    if (!REAL_TRADING && trade) {
      const slippageTicks = 1 + Math.floor(Math.random() * 3);
      log('SLIPPAGE_QUEUE_SELL', token.symbol, token.mint, { triggerExitMc: Math.round(exitMc), reason, delayTicks: slippageTicks });
      pendingSells.set(token.mint, { token, trade, reason, triggerExitMc: exitMc, ticksLeft: slippageTicks, queuedAt: Date.now() });
      return;
    }

    openCount = Math.max(0, openCount - 1);

    if (trade) {
      const pnl = trade.pnlPct;
      if (pnl > 0) { totalWins++; netPnlSol += POSITION_SOL * (pnl / 100); }
      else          { totalLosses++; netPnlSol += POSITION_SOL * (pnl / 100); }
      totalFeesSol += POSITION_SOL * TRADE_FEE_PCT;
    }

    broadcast({
      type: 'sell', mint: token.mint, symbol: token.symbol,
      pnl: trade?.pnlPct?.toFixed(2), reason, exitMc: Math.round(exitMc),
      tranchesSold: trade?.tranchesSold || 0,
    });

    if (REAL_TRADING && trade?.remainingSol > 0.001) {
      retrySell(token.mint, token.symbol).then(result => {
        log('SELL_REAL', token.symbol, token.mint, { sig: result.signature?.slice(0,12), solReceived: result.solReceived, reason });
        if (getSolBalance) getSolBalance().then(b => { realWalletSol = b; }).catch(() => {});
      }).catch(e => {
        log('SELL_FAIL', token.symbol, token.mint, { error: e.message });
      });
    }
  }
}

async function retrySell(mint, symbol) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return await executeSell(mint); }
    catch (e) {
      log('SELL_RETRY', symbol, mint, { attempt, error: e.message });
      if (attempt < 4) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw new Error('sell failed after 4 attempts');
}

// ── PumpPortal WebSocket ─────────────────────────────────────────
let lastPpMsg = Date.now();

function connectPP() {
  console.log('📡 Connecting to PumpPortal...');
  ppWs = new WebSocket(PP_WS_URL);

  ppWs.on('open', () => {
    ppReady = true;
    console.log('✅ PumpPortal connected');
    ppWs.send(JSON.stringify({ method: 'subscribeNewToken' }));

    // Re-subscribe all tracked mints
    const allMints = [...registry.keys(), ...nursery.keys(), ...coldWatch];
    if (allMints.length > 0) {
      resubscribeBatched(allMints);
    }
  });

  ppWs.on('message', async (raw) => {
    lastPpMsg = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── New token birth → nursery ──────────────────────────────
    if (msg.txType === 'create') {
      const mint   = msg.mint;
      if (!mint || registry.has(mint) || nursery.has(mint)) return;

      nurseryTotal++;
      const birthMc = (msg.marketCapSol || 0) * solPrice;

      // Evict oldest dead token if nursery is full
      if (nursery.size >= NURSERY_MAX) {
        let oldestDead = null, oldestTs = Infinity;
        for (const [m, nr] of nursery) {
          if (nr.trades === 0 && nr.birthTs < oldestTs) {
            oldestDead = m; oldestTs = nr.birthTs;
          }
        }
        if (oldestDead) {
          nursery.delete(oldestDead);
          coldWatch.add(oldestDead);
        } else return;
      }

      nursery.set(mint, {
        mint, symbol: msg.symbol || mint.slice(0,6), name: msg.name || '',
        birthMc, currentMc: birthMc, ath: birthMc, low: birthMc,
        birthTs: Date.now(), lastTradeTs: Date.now(),
        trades: 0, buySol: 0,
        uniqueTraders: new Set(),
        uniqueBuyers: new Set(),
      });

      ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      return;
    }

    // ── Trade event ────────────────────────────────────────────
    const mint = msg.mint;
    if (!mint) return;

    const rawIsBuy   = msg.txType === 'buy';
    let   sol        = Number(msg.solAmount) || 0;
    const mcSol      = Number(msg.marketCapSol) || 0;
    const mc         = mcSol * solPrice;
    if (mc <= 0) return;

    // ── Data bounds: reject garbage ticks ────────────────────
    if (sol < 0) sol = 0;
    if (sol > MAX_SOL_PER_TICK) {
      log('BOUNDS_REJECT', msg.symbol || mint.slice(0,6), mint, { reason: 'solAmount', sol, max: MAX_SOL_PER_TICK });
      sol = 0;  // still process the tick for MC tracking, but zero out the SOL
    }
    if (mc > MC_BONDING_CURVE_MAX) return;  // impossible on bonding curve

    // ── Nursery token tick ──────────────────────────────────────
    if (nursery.has(mint)) {
      const nr = nursery.get(mint);
      nr.currentMc = mc;
      nr.lastTradeTs = Date.now();
      nr.trades++;
      if (mc > nr.ath) nr.ath = mc;
      if (mc < nr.low && mc > 0) nr.low = mc;
      if (rawIsBuy) {
        nr.buySol += sol;
        if (msg.traderPublicKey) nr.uniqueBuyers.add(msg.traderPublicKey);
      }
      if (msg.traderPublicKey) nr.uniqueTraders.add(msg.traderPublicKey);
      return;
    }

    // ── Cold-watch token waking up ──────────────────────────────
    if (coldWatch.has(mint) && !registry.has(mint)) {
      if (mc >= COLD_PROMOTE_MC * solPrice / 150) {
        coldWatch.delete(mint);
        const token = await ensureToken(mint, msg.symbol, msg.name, 'old');
        token.isSeeded = true;
        loadHistory(token).catch(() => {});
        log('COLD_PROMOTE', token.symbol, mint, { mc: Math.round(mc) });
      }
      return;
    }

    // ── Registry token tick ─────────────────────────────────────
    let token = registry.get(mint);
    if (!token) {
      const category = (msg.vSolInBondingCurve || 0) >= 85 ? 'migrated' : 'old';
      token = await ensureToken(mint, msg.symbol, msg.name, category);
      ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }

    // MC spike rejection: if MC changes >50% in one tick and we have prior data, skip
    if (token.prevMcSol > 0 && token.liveTrades > 3) {
      const spike = Math.abs(mcSol - token.prevMcSol) / token.prevMcSol;
      if (spike > MAX_MC_CHANGE_PCT) {
        log('BOUNDS_REJECT', token.symbol, mint, { reason: 'mc_spike', prevMcSol: token.prevMcSol, mcSol, spike: (spike*100).toFixed(1)+'%' });
        return;
      }
    }

    // MC direction correction — but NOT for catalyst-sized buys (preserve raw txType for catalyst gate)
    let isBuy = rawIsBuy;
    if (token.prevMcSol > 0 && sol < CATALYST_MIN_SOL) {
      const mcDelta = (mcSol - token.prevMcSol) / token.prevMcSol;
      if (Math.abs(mcDelta) > MC_DIRECTION_MIN_DELTA) {
        const mcSaysBuy = mcDelta > 0;
        if (mcSaysBuy !== rawIsBuy) isBuy = mcSaysBuy;
      }
    }
    token.prevMcSol = mcSol;

    // Update pool size
    const vSol = msg.vSolInBondingCurve || 0;
    if (vSol > 0) token.vSol = vSol;

    // Quality tracking (new pairs)
    if (token.category === 'new' && isBuy && msg.traderPublicKey) {
      if (token.uniqueBuyers) token.uniqueBuyers.add(msg.traderPublicKey);
      if (mc < QUALITY_MC_THRESHOLD && sol > QUALITY_MAX_BUY_SOL) {
        token.maxEarlyBuySol = Math.max(token.maxEarlyBuySol, sol);
      }
    }

    // Mayhem detection
    if (msg.traderPublicKey === MAYHEM_AGENT_WALLET) {
      token.mayhemDetected = true;
    }

    // Tracked wallet detection on our coins
    const walletLabel = msg.traderPublicKey ? TRACKED_WALLETS.get(msg.traderPublicKey) : null;
    if (walletLabel) {
      if (!walletComparisons.has(mint)) {
        walletComparisons.set(mint, { walletTrades: [], ourTrades: [] });
      }
      const comp = walletComparisons.get(mint);
      comp.walletTrades.push({
        ts: Date.now(), wallet: walletLabel, isBuy, sol, mc: Math.round(mc),
        state: token.state, ourFloor: Math.round(token.sessionLow < Infinity ? token.sessionLow : 0),
        ourArmed: token.state === 'ARMED',
      });
      log('WALLET_TRADE', token.symbol, mint, {
        wallet: walletLabel, side: isBuy ? 'BUY' : 'SELL',
        sol: sol.toFixed(3), mc: Math.round(mc),
        ourState: token.state, ourFloor: Math.round(token.sessionLow < Infinity ? token.sessionLow : 0),
        ourWins: token.winCount || 0, ourTradeCount: token.tradeCount || 0,
      });
    }

    // Process pending slippage buys/sells on each tick
    if (pendingBuys.has(mint)) {
      const pb = pendingBuys.get(mint);
      pb.ticksLeft--;
      if (pb.ticksLeft <= 0) {
        pendingBuys.delete(mint);
        const slippedMc = mc;
        const slipPct = ((slippedMc - pb.triggerMc) / pb.triggerMc * 100).toFixed(2);
        log('SLIPPAGE_BUY', pb.token.symbol, mint, { triggerMc: Math.round(pb.triggerMc), fillMc: Math.round(slippedMc), slipPct });
        const trade = confirmBuy(pb.token, slippedMc, 'paper_' + Date.now(), 0, log);
        if (trade) {
          pb.token.proven = true;
          if (!walletComparisons.has(mint)) walletComparisons.set(mint, { walletTrades: [], ourTrades: [] });
          walletComparisons.get(mint).ourTrades.push({ ts: Date.now(), isBuy: true, sol: POSITION_SOL, mc: Math.round(slippedMc) });
          broadcast({ type: 'buy', mint, symbol: pb.token.symbol, mc: Math.round(slippedMc), jito: pb.token.jitoBundle, slipPct });
        } else { openCount = Math.max(0, openCount - 1); }
      }
    }
    if (pendingSells.has(mint)) {
      const ps = pendingSells.get(mint);
      ps.ticksLeft--;
      if (ps.ticksLeft <= 0) {
        pendingSells.delete(mint);
        const slippedExitMc = mc;
        const slipPct = ((slippedExitMc - ps.triggerExitMc) / ps.triggerExitMc * 100).toFixed(2);
        log('SLIPPAGE_SELL', ps.token.symbol, mint, { triggerExitMc: Math.round(ps.triggerExitMc), fillExitMc: Math.round(slippedExitMc), slipPct, reason: ps.reason });
        openCount = Math.max(0, openCount - 1);

        // Blended PnL: account for DCA partial sells already executed
        const partials = ps.trade.partialSells || [];
        const remainSol = ps.trade.remainingSol || POSITION_SOL;
        const posSol = ps.trade.positionSol || POSITION_SOL;
        let totalReturn = 0;
        for (const p of partials) { totalReturn += p.solSold * (1 + p.pnlPct / 100); }
        const remainPnlRaw = (slippedExitMc - ps.trade.entryMc) / ps.trade.entryMc * 100;
        const remainPnl = remainPnlRaw - (TRADE_FEE_PCT * 100);
        totalReturn += remainSol * (1 + remainPnl / 100);
        const pnl = ((totalReturn / posSol) - 1) * 100;

        if (pnl > 0) { totalWins++; netPnlSol += posSol * (pnl / 100); }
        else          { totalLosses++; netPnlSol += posSol * (pnl / 100); }
        totalFeesSol += posSol * TRADE_FEE_PCT;
        if (!walletComparisons.has(mint)) walletComparisons.set(mint, { walletTrades: [], ourTrades: [] });
        walletComparisons.get(mint).ourTrades.push({ ts: Date.now(), isBuy: false, sol: remainSol, mc: Math.round(slippedExitMc), pnl: +pnl.toFixed(2), reason: ps.reason });
        broadcast({ type: 'sell', mint, symbol: ps.token.symbol, pnl: pnl.toFixed(2), reason: ps.reason, exitMc: Math.round(slippedExitMc), slipPct, tranchesSold: ps.trade.tranchesSold || 0 });
      }
    }

    // Feed tick to algo
    const event = onTick(token, mc, Date.now(), isBuy, sol, openCount, false, log);
    await handleEvent(event);
  });

  ppWs.on('close', () => {
    ppReady = false;
    console.log('🔌 PumpPortal disconnected — reconnecting in 3s...');
    setTimeout(connectPP, 3_000);
  });

  ppWs.on('error', e => {
    console.error('⚠️  PP error:', e.message);
    ppReady = false;
    try { ppWs.close(); } catch (_) {}
  });
}

// ── Batch re-subscription ────────────────────────────────────────
async function resubscribeBatched(mints) {
  for (let i = 0; i < mints.length; i += RESUB_BATCH_SIZE) {
    const batch = mints.slice(i, i + RESUB_BATCH_SIZE);
    if (ppWs && ppWs.readyState === 1) {
      ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: batch }));
    }
    if (i + RESUB_BATCH_SIZE < mints.length) {
      await new Promise(r => setTimeout(r, RESUB_BATCH_DELAY_MS));
    }
  }
  console.log(`📡 Re-subscribed ${mints.length} mints in batches of ${RESUB_BATCH_SIZE}`);
}

// ── SOL price updater ────────────────────────────────────────────
async function refreshSolPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(5_000) });
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}
}

// ── Persistence ──────────────────────────────────────────────────
const SNAPSHOT_FILE = path.join(DATA_DIR, 'registry_snapshot.json');
const NURSERY_FILE  = path.join(DATA_DIR, 'nursery_snapshot.json');
const COLD_FILE     = path.join(DATA_DIR, 'coldwatch_snapshot.json');

function saveSnapshot() {
  try {
    const regSnap = {};
    for (const [mint, t] of registry) {
      regSnap[mint] = {
        mint: t.mint, symbol: t.symbol, name: t.name, category: t.category,
        state: t.state, currentMc: t.currentMc,
        sessionHigh: t.sessionHigh, sessionLow: t.sessionLow === Infinity ? null : t.sessionLow,
        vSol: t.vSol, historyLoaded: t.historyLoaded, historyTrades: t.historyTrades,
        liveTrades: t.liveTrades || 0, isSeeded: t.isSeeded || false,
        jitoBundle: t.jitoBundle, bundlePeakMc: t.bundlePeakMc,
        mayhemDetected: t.mayhemDetected,
        tradeCount: t.tradeCount, lastExitMc: t.lastExitMc,
        cooldownUntil: t.cooldownUntil,
        floorTouches: t.floorTouches, historyFloorTouches: t.historyFloorTouches,
        maxEarlyBuySol: t.maxEarlyBuySol,
        resolvedBuyerCount: t.resolvedBuyerCount,
        uniqueBuyersArr: [...(t.uniqueBuyers || [])],
        prevMcSol: t.prevMcSol,
        proven: t.proven || false,
        isNurseryGrad: t.isNurseryGrad || false,
        winCount: t.winCount || 0,
      };
    }
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(regSnap));

    const nurSnap = {};
    for (const [mint, nr] of nursery) {
      nurSnap[mint] = { ...nr, uniqueTraders: [...(nr.uniqueTraders || [])], uniqueBuyers: [...(nr.uniqueBuyers || [])] };
    }
    fs.writeFileSync(NURSERY_FILE, JSON.stringify(nurSnap));

    fs.writeFileSync(COLD_FILE, JSON.stringify([...coldWatch]));
  } catch (e) {
    console.error('Snapshot save error:', e.message);
  }
}

function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      let restored = 0;
      for (const [mint, snap] of Object.entries(data)) {
        const token = makeToken(mint, snap.symbol, snap.name, snap.category);
        Object.assign(token, {
          state: snap.state || STATE.WATCHING,
          currentMc: snap.currentMc || 0,
          sessionHigh: snap.sessionHigh || 0,
          sessionLow: snap.sessionLow ?? Infinity,
          vSol: snap.vSol || 0,
          historyLoaded: snap.historyLoaded || false,
          historyTrades: snap.historyTrades || 0,
          liveTrades: snap.liveTrades || 0,
          isSeeded: snap.isSeeded || false,
          jitoBundle: snap.jitoBundle || false,
          bundlePeakMc: snap.bundlePeakMc || 0,
          mayhemDetected: snap.mayhemDetected || false,
          tradeCount: snap.tradeCount || 0,
          lastExitMc: snap.lastExitMc || null,
          cooldownUntil: snap.cooldownUntil || 0,
          floorTouches: snap.floorTouches || 0,
          historyFloorTouches: snap.historyFloorTouches || 0,
          maxEarlyBuySol: snap.maxEarlyBuySol || 0,
          resolvedBuyerCount: snap.resolvedBuyerCount || 0,
          prevMcSol: snap.prevMcSol || 0,
          proven: snap.proven || false,
          isNurseryGrad: snap.isNurseryGrad || false,
          winCount: snap.winCount || 0,
        });
        if (snap.uniqueBuyersArr?.length) {
          for (const w of snap.uniqueBuyersArr) token.uniqueBuyers.add(w);
        }

        // Force-close any active trades from previous session
        if ([STATE.HOLDING, STATE.EXIT_UNLOCKED, STATE.BUYING].includes(token.state)) {
          token.state = STATE.CLOSED;
          token.cooldownUntil = Date.now() / 1000 + 30;
          token.activeTrade = null;
          log('RESTART_CLOSE', token.symbol, mint, { prevState: snap.state });
        }

        registry.set(mint, token);
        restored++;
      }
      console.log(`📂 Registry restored: ${restored} tokens`);
    }

    if (fs.existsSync(NURSERY_FILE)) {
      const data = JSON.parse(fs.readFileSync(NURSERY_FILE, 'utf8'));
      for (const [mint, snap] of Object.entries(data)) {
        if (registry.has(mint)) continue;
        nursery.set(mint, {
          ...snap,
          uniqueTraders: new Set(snap.uniqueTraders || []),
          uniqueBuyers: new Set(snap.uniqueBuyers || []),
        });
      }
      console.log(`🌱 Nursery restored: ${nursery.size} tokens`);
    }

    if (fs.existsSync(COLD_FILE)) {
      const data = JSON.parse(fs.readFileSync(COLD_FILE, 'utf8'));
      for (const mint of data) {
        if (!registry.has(mint) && !nursery.has(mint)) coldWatch.add(mint);
      }
      console.log(`❄️  Cold-watch restored: ${coldWatch.size} mints`);
    }
  } catch (e) {
    console.error('Snapshot load error:', e.message);
  }
}

// ── Express server ───────────────────────────────────────────────
const app    = express();
const server = createServer(app);

app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  const query  = req.query.token;
  if (bearer === AUTH_TOKEN || query === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>2Wallets Algo v2.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e0e0e0;font-family:'SF Mono','Fira Code',monospace;font-size:13px}
.header{padding:16px 24px;border-bottom:1px solid #1e1e2e;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:18px;font-weight:600;color:#f0f0f0}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
.dot.on{background:#4ade80}.dot.off{background:#ef4444}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;padding:16px 24px}
.card{background:#12121a;border:1px solid #1e1e2e;border-radius:8px;padding:14px 16px}
.card .label{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
.card .value{font-size:22px;font-weight:700;margin-top:4px;color:#f0f0f0}
.card .value.green{color:#4ade80}.card .value.red{color:#f87171}.card .value.blue{color:#60a5fa}.card .value.yellow{color:#fbbf24}
.tabs{display:flex;gap:0;padding:0 24px;border-bottom:1px solid #1e1e2e;margin-top:8px}
.tab{padding:10px 20px;cursor:pointer;color:#666;border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:#aaa}.tab.active{color:#7dd3fc;border-bottom-color:#7dd3fc}
.panel{padding:16px 24px;display:none}.panel.active{display:block}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:#555;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;border-bottom:1px solid #1e1e2e}
td{padding:7px 10px;border-bottom:1px solid #0e0e16;white-space:nowrap}
tr:hover{background:#15151f}
.mint{cursor:pointer;color:#7dd3fc;font-size:12px}.mint:hover{text-decoration:underline}
.badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600}
.badge.armed{background:#422006;color:#fbbf24}.badge.floored{background:#1a2332;color:#60a5fa}
.badge.indexed{background:#1a1a2e;color:#a78bfa}.badge.watching{background:#111;color:#666}
.badge.holding,.badge.exit_unlocked{background:#052e16;color:#4ade80}
.badge.closed{background:#1a1a1a;color:#888}.badge.blacklisted{background:#2a0a0a;color:#f87171}
.badge.jito{background:#3b0764;color:#c084fc;margin-left:4px}
.pnl-pos{color:#4ade80;font-weight:600}.pnl-neg{color:#f87171;font-weight:600}
.stale{color:#444}.empty{color:#444;padding:30px;text-align:center}
.sse-log{max-height:340px;overflow-y:auto;background:#08080c;border:1px solid #1e1e2e;border-radius:8px;padding:12px;font-size:12px;line-height:1.7}
.sse-buy{color:#4ade80}.sse-sell{color:#f87171}.sse-arm{color:#fbbf24}.sse-disarm{color:#666}
</style>
</head>
<body>
<div class="header">
  <div><h1>2Wallets Algo</h1><span style="color:#888;font-size:12px" id="ver">v2.0.0</span></div>
  <div style="display:flex;gap:12px;align-items:center">
    <span><span class="dot" id="ppDot"></span>PumpPortal</span>
    <span id="modeLabel"></span>
  </div>
</div>
<div class="grid" id="statsGrid"></div>
<div class="tabs">
  <div class="tab active" data-tab="registry">Registry</div>
  <div class="tab" data-tab="nursery">Nursery 🌱</div>
  <div class="tab" data-tab="trades">Closed Trades</div>
  <div class="tab" data-tab="live">Live Feed</div>
</div>
<div class="panel active" id="panel-registry"></div>
<div class="panel" id="panel-nursery"></div>
<div class="panel" id="panel-trades"></div>
<div class="panel" id="panel-live"><div class="sse-log" id="sseLog"><div style="color:#444">Waiting for events...</div></div></div>
<div style="color:#444;font-size:11px;padding:4px 24px">Auto-refreshes every 5s</div>
<script>
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function copyMint(mint){navigator.clipboard.writeText(mint).then(()=>{const el=document.querySelector('[data-mint="'+mint+'"]');if(el){const o=el.textContent;el.textContent='copied!';setTimeout(()=>el.textContent=o,800)}});}
function fmtMc(n){return n>=1000?(n/1000).toFixed(1)+'K':Math.round(n)}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function badge(s,jito){const cls=s.toLowerCase().replace('exit_unlocked','holding');let b='<span class="badge '+cls+'">'+s+'</span>';if(jito)b+='<span class="badge jito">JITO</span>';return b}

async function loadStats(){
  try{
    const d=await(await fetch('/api/stats')).json();
    $('#ver').textContent=d.version||'?';
    $('#ppDot').className='dot '+(d.ppConnected?'on':'off');
    $('#modeLabel').innerHTML=d.realTrading?'<span style="color:#f87171;font-weight:700">REAL</span>':'<span style="color:#4ade80">PAPER</span>';
    const pnlCls=d.netPnlSol>=0?'green':'red';
    const wr=d.trades>0?(d.wins/d.trades*100).toFixed(0)+'%':'—';
    const cards=[
      {label:'Net PnL',value:(d.netPnlSol>=0?'+':'')+d.netPnlSol.toFixed(4)+' SOL',cls:pnlCls},
      {label:'Trades',value:d.trades,cls:''},
      {label:'Win Rate',value:wr,cls:d.winRate>=50?'green':d.trades>0?'red':''},
      {label:'Open',value:d.open,cls:d.open>0?'yellow':''},
      {label:'Armed',value:d.armed,cls:d.armed>0?'yellow':''},
      {label:'Registry',value:d.tokens,cls:'blue'},
      {label:'Nursery',value:d.nurserySize,cls:''},
      {label:'Cold Watch',value:d.coldWatchSize??0,cls:''},
      {label:'Born Total',value:d.nurseryTotal??0,cls:''},
      {label:'Watchdog',value:(d.watchdogKills||0)+'/'+(d.watchdogRuns||0),cls:''},
    ];
    $('#statsGrid').innerHTML=cards.map(c=>'<div class="card"><div class="label">'+c.label+'</div><div class="value '+c.cls+'">'+c.value+'</div></div>').join('');
  }catch(e){}
}

async function loadRegistry(){
  try{
    const list=await(await fetch('/api/registry')).json();
    if(!list.length){$('#panel-registry').innerHTML='<div class="empty">No tokens in registry yet</div>';return}
    let h='<table><thead><tr><th>Token</th><th>CA</th><th>State</th><th>MC</th><th>ATH</th><th>Floor</th><th>Buyers</th><th>Hist</th><th>Live</th><th>Last Tick</th></tr></thead><tbody>';
    for(const t of list){h+='<tr><td><b>'+esc(t.symbol)+'</b></td><td><span class="mint" data-mint="'+t.mint+'" onclick="copyMint(\''+t.mint+'\')">'+t.mint.slice(0,6)+'…'+t.mint.slice(-4)+'</span></td><td>'+badge(t.state,t.jitoBundle)+'</td><td>$'+fmtMc(t.mc)+'</td><td>$'+fmtMc(t.ath)+'</td><td>'+(t.floor?'$'+fmtMc(t.floor):'—')+'</td><td>'+t.buyers+'</td><td>'+(t.histLoaded?t.histTrades:'<span class="stale">…</span>')+'</td><td>'+t.liveTrades+'</td><td class="stale">'+(t.lastTick||'—')+'</td></tr>'}
    $('#panel-registry').innerHTML=h+'</tbody></table>';
  }catch(e){}
}

async function loadNursery(){
  try{
    const list=await(await fetch('/api/nursery')).json();
    if(!list.length){$('#panel-nursery').innerHTML='<div class="empty">Nursery is empty</div>';return}
    let h='<table><thead><tr><th>Token</th><th>CA</th><th>MC</th><th>ATH</th><th>Trades</th><th>Traders</th><th>Age</th></tr></thead><tbody>';
    for(const n of list){h+='<tr><td><b>'+esc(n.symbol)+'</b></td><td><span class="mint" data-mint="'+n.mint+'" onclick="copyMint(\''+n.mint+'\')">'+n.mint.slice(0,6)+'…'+n.mint.slice(-4)+'</span></td><td>$'+fmtMc(n.mc)+'</td><td>$'+fmtMc(n.ath)+'</td><td>'+n.trades+'</td><td>'+n.traders+'</td><td>'+n.ageSec+'s</td></tr>'}
    $('#panel-nursery').innerHTML=h+'</tbody></table>';
  }catch(e){}
}

async function loadTrades(){
  try{
    const list=await(await fetch('/api/closed')).json();
    if(!list.length){$('#panel-trades').innerHTML='<div class="empty">No closed trades yet</div>';return}
    let h='<table><thead><tr><th>Token</th><th>CA</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Hold</th><th>Reason</th></tr></thead><tbody>';
    for(const t of list){const cls=t.pnlPct>=0?'pnl-pos':'pnl-neg';h+='<tr><td><b>'+esc(t.symbol)+'</b>'+(t.jito?'<span class="badge jito">JITO</span>':'')+'</td><td><span class="mint" data-mint="'+t.mint+'" onclick="copyMint(\''+t.mint+'\')">'+t.mint.slice(0,6)+'…'+t.mint.slice(-4)+'</span></td><td>$'+fmtMc(t.entryMc)+'</td><td>$'+fmtMc(t.exitMc)+'</td><td class="'+cls+'">'+(t.pnlPct>=0?'+':'')+t.pnlPct+'%</td><td>'+t.holdSec+'s</td><td>'+t.reason+'</td></tr>'}
    $('#panel-trades').innerHTML=h+'</tbody></table>';
  }catch(e){}
}

$$('.tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    $$('.tab').forEach(t=>t.classList.remove('active'));
    $$('.panel').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-'+tab.dataset.tab).classList.add('active');
  });
});

const sse=new EventSource('/api/sse');
const sseLog=$('#sseLog');
sse.onmessage=(e)=>{
  try{
    const d=JSON.parse(e.data);
    let cls='',txt='';
    if(d.type==='buy'){cls='sse-buy';txt='BUY  '+d.symbol+' at $'+fmtMc(d.mc)+(d.jito?' [JITO R2]':'')}
    if(d.type==='dca_sell'){cls='sse-buy';txt='DCA T'+d.tranche+' '+d.symbol+' '+d.pct+'% at $'+fmtMc(d.mc)+' ('+d.mult+'x) → '+d.remaining+' SOL left'}
    if(d.type==='sell'){cls='sse-sell';txt='EXIT '+d.symbol+' → '+(d.pnl||'?')+'% ('+d.reason+') ['+(d.tranchesSold||0)+'/4 DCA]'}
    if(d.type==='arm'){cls='sse-arm';txt='ARM  '+d.symbol+' at $'+fmtMc(d.mc)}
    if(d.type==='disarm'){cls='sse-disarm';txt='DISARM '+d.symbol}
    if(txt){
      const ts=new Date().toLocaleTimeString();
      const line=document.createElement('div');
      line.className='sse-line '+cls;
      line.textContent='['+ts+'] '+txt;
      sseLog.prepend(line);
      while(sseLog.children.length>200)sseLog.lastChild.remove();
    }
  }catch{}
};

function refresh(){
  loadStats();
  const t=$('.tab.active')?.dataset.tab;
  if(t==='registry')loadRegistry();
  if(t==='nursery')loadNursery();
  if(t==='trades')loadTrades();
}
refresh();
setInterval(refresh,5000);
</script>
</body>
</html>`);
});

app.get('/api/stats', (_req, res) => {
  const tokens = [...registry.values()];
  const byState = {};
  for (const t of tokens) byState[t.state] = (byState[t.state] || 0) + 1;

  const open  = tokens.filter(t => [STATE.HOLDING, STATE.EXIT_UNLOCKED, STATE.BUYING].includes(t.state)).length;
  const armed = tokens.filter(t => t.state === STATE.ARMED).length;
  const activeTokens = tokens
    .filter(t => ![STATE.WATCHING, STATE.BLACKLISTED].includes(t.state))
    .map(t => ({
      symbol: t.symbol, mint: t.mint, state: t.state,
      mc: Math.round(t.currentMc || 0),
      jito: t.jitoBundle,
    }))
    .sort((a, b) => b.mc - a.mc)
    .slice(0, 30);

  res.json({
    version:    '3.1.0',
    realTrading: REAL_TRADING,
    halted:     tradingHalted,
    walletSol:  realWalletSol,
    startingSol,
    netPnlSol,
    trades:     totalWins + totalLosses,
    wins:       totalWins,
    losses:     totalLosses,
    winRate:    totalWins + totalLosses > 0 ? +(totalWins / (totalWins + totalLosses) * 100).toFixed(1) : 0,
    open, armed,
    tokens:     tokens.length,
    nurserySize: nursery.size,
    coldWatchSize: coldWatch.size,
    nurseryTotal,
    ppConnected: ppReady,
    laserSlots: laserSlots.size,
    watchdogRuns, watchdogKills,
    byState, activeTokens,
    provenTokens: tokens.filter(t => (t.winCount || 0) >= 1).length,
    maxConcurrent: 5,
  });
});

app.get('/api/registry', (_req, res) => {
  const all = [...registry.values()].map(t => ({
    symbol: t.symbol, mint: t.mint, state: t.state, category: t.category,
    mc: Math.round(t.currentMc || 0),
    ath: Math.round(t.sessionHigh || 0),
    floor: Math.round(t.sessionLow < Infinity ? t.sessionLow : 0),
    buyers: Math.max(t.uniqueBuyers?.size ?? 0, t.resolvedBuyerCount ?? 0),
    histLoaded: t.historyLoaded, histTrades: t.historyTrades,
    liveTrades: t.liveTrades || 0, isSeeded: t.isSeeded || false,
    jitoBundle: t.jitoBundle, bundlePeakMc: Math.round(t.bundlePeakMc || 0),
    tradeCount: t.tradeCount || 0, winCount: t.winCount || 0,
    proven: t.proven || false,
    lastTick: t.lastTickTs ? Math.round((Date.now() - t.lastTickTs) / 1000) + 's ago' : 'never',
    lastTickTs: t.lastTickTs || 0,
  })).sort((a, b) => b.ath - a.ath);
  res.json(all);
});

app.get('/api/nursery', (_req, res) => {
  const all = [...nursery.values()].map(nr => ({
    symbol: nr.symbol, mint: nr.mint,
    mc: Math.round(nr.currentMc || 0),
    ath: Math.round(nr.ath || 0),
    trades: nr.trades,
    traders: nr.uniqueTraders?.size || 0,
    ageSec: Math.round((Date.now() - nr.birthTs) / 1000),
  })).sort((a, b) => b.trades - a.trades);
  res.json(all);
});

app.get('/api/closed', (_req, res) => {
  const all = [];
  for (const t of registry.values()) {
    for (const trade of (t.closedTrades || [])) {
      all.push({
        symbol:  t.symbol, mint: t.mint, jito: t.jitoBundle,
        ...trade,
        entryMc: Math.round(trade.entryMc),
        exitMc:  Math.round(trade.exitMc),
        holdSec: +trade.holdSec.toFixed(1),
        pnlPct:  +trade.pnlPct.toFixed(2),
      });
    }
  }
  all.sort((a, b) => (b.exitTs || 0) - (a.exitTs || 0));
  res.json(all);
});

app.get('/api/diag', (_req, res) => {
  res.json({
    note: 'use /api/stats for state info, /api/nursery for nursery',
    ppMsgLog: global._ppMsgLog || [],
  });
});

app.get('/api/wallet-compare', (_req, res) => {
  const result = [];
  for (const [mint, comp] of walletComparisons) {
    const token = registry.get(mint);
    if (comp.walletTrades.length === 0 && comp.ourTrades.length === 0) continue;
    result.push({
      mint,
      symbol: token?.symbol || '?',
      mc: Math.round(token?.currentMc || 0),
      floor: Math.round(token?.sessionLow < Infinity ? (token?.sessionLow || 0) : 0),
      ath: Math.round(token?.sessionHigh || 0),
      state: token?.state || '?',
      ourWins: token?.winCount || 0,
      ourTradeCount: token?.tradeCount || 0,
      walletTrades: comp.walletTrades,
      ourTrades: comp.ourTrades,
      walletBuys: comp.walletTrades.filter(t => t.isBuy).length,
      walletSells: comp.walletTrades.filter(t => !t.isBuy).length,
      ourBuys: comp.ourTrades.filter(t => t.isBuy).length,
      ourSells: comp.ourTrades.filter(t => !t.isBuy).length,
    });
  }
  res.json(result.sort((a, b) => b.walletTrades.length - a.walletTrades.length));
});

app.get('/api/audit', (_req, res) => {
  const tokens = [...registry.values()];
  const now = Date.now();

  const armedAudit = [];
  const blockedAudit = [];
  const staleReport = [];
  const tradeGateCheck = [];

  for (const t of tokens) {
    const staleSec = t.lastTickTs ? Math.round((now - t.lastTickTs) / 1000) : -1;

    if (staleSec > 90 && t.state !== 'BLACKLISTED') {
      staleReport.push({ mint: t.mint, symbol: t.symbol, state: t.state, staleSec });
    }

    // For ARMED tokens: verify all 9 gates still pass
    if (t.state === 'ARMED') {
      const gateResult = runEntryGates(t, true, 0.25, t.currentMc, openCount, () => {});
      armedAudit.push({
        mint: t.mint, symbol: t.symbol,
        mc: Math.round(t.currentMc),
        floor: Math.round(t.sessionLow < Infinity ? t.sessionLow : 0),
        ath: Math.round(t.sessionHigh),
        allGatesPass: gateResult.pass,
        failedGate: gateResult.pass ? null : gateResult.gate,
        failReason: gateResult.pass ? null : gateResult.reason,
        floorTouches: t.floorTouches,
        histFloorTouches: t.historyFloorTouches,
        confirmedFloorTouches: t.confirmedFloorTouches,
        buyers: Math.max(t.uniqueBuyers?.size ?? 0, t.resolvedBuyerCount ?? 0),
        proven: t.proven || false,
      });
    }

    // For INDEXED/FLOORED: which gate is blocking?
    if (t.state === 'INDEXED' || t.state === 'FLOORED') {
      const floorResult = floorGate(t);
      const floor = t.sessionLow < Infinity ? t.sessionLow : 0;
      const aboveFloor = floor > 0 ? (t.currentMc - floor) / floor : 0;
      const hasRealPump = t.sessionHigh > floor * 1.50;
      blockedAudit.push({
        mint: t.mint, symbol: t.symbol, state: t.state,
        mc: Math.round(t.currentMc),
        floor: Math.round(floor),
        ath: Math.round(t.sessionHigh),
        floorGatePass: floorResult.pass,
        floorGateReason: floorResult.reason,
        aboveFloorPct: +(aboveFloor * 100).toFixed(1),
        hasRealPump,
        floorTouches: Math.max(t.floorTouches || 0, t.historyFloorTouches || 0, t.confirmedFloorTouches || 0),
        histLoaded: t.historyLoaded,
        liveTrades: t.liveTrades || 0,
        jitoBundle: t.jitoBundle,
      });
    }

    // For tokens with closed trades: verify exit gates
    for (const trade of (t.closedTrades || [])) {
      tradeGateCheck.push({
        mint: t.mint, symbol: t.symbol,
        tradeId: trade.id,
        entryMc: Math.round(trade.entryMc),
        exitMc: Math.round(trade.exitMc),
        pnlPct: +trade.pnlPct?.toFixed(2),
        reason: trade.reason,
        holdSec: +trade.holdSec?.toFixed(1),
        tokenFloor: Math.round(t.sessionLow < Infinity ? t.sessionLow : 0),
        tokenAth: Math.round(t.sessionHigh),
      });
    }
  }

  res.json({
    ts: new Date().toISOString(),
    registrySize: tokens.length,
    staleCount: staleReport.length,
    armedCount: armedAudit.length,
    blockedCount: blockedAudit.length,
    tradeCount: tradeGateCheck.length,
    staleReport: staleReport.slice(0, 50),
    armedAudit,
    blockedAudit: blockedAudit.slice(0, 50),
    tradeGateCheck,
    pendingBuys: pendingBuys.size,
    pendingSells: pendingSells.size,
  });
});

app.get('/api/sse', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Start ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🐊 2Wallets Algo v3.0 (DCA Hold Strategy) — port ${PORT}`);
  console.log(`📁 Logging to: ${LOG_FILE}`);
  console.log(`⚡ Real trading: ${REAL_TRADING}`);
  console.log();
});

// Load persisted state BEFORE connecting
loadSnapshot();

connectPP();

// Seed old coins 5s after startup, then every 3 min
setTimeout(() => {
  seedOldCoins().catch(() => {});
  setInterval(() => seedOldCoins().catch(() => {}), 3 * 60_000);
}, 5_000);

// SOL price refresh
refreshSolPrice();
setInterval(refreshSolPrice, 60_000);

// ── Nursery purge: every 3 minutes ───────────────────────────────
setInterval(async () => {
  const now = Date.now();
  let purged = 0, promoted = 0;
  const toPromote = [];
  const toPurge = [];

  for (const [mint, nr] of nursery) {
    const age = now - nr.birthTs;
    if (age < NURSERY_PURGE_MS) continue;

    const recentTrade = (now - nr.lastTradeTs) < NURSERY_PURGE_MS;
    const enoughTraders = (nr.uniqueTraders?.size || 0) >= NURSERY_MIN_TRADERS;

    if (!recentTrade && !enoughTraders) {
      toPurge.push(mint);
    } else {
      toPromote.push(mint);
    }
  }

  for (const mint of toPurge) {
    nursery.delete(mint);
    coldWatch.add(mint);
    purged++;
  }

  // Promote survivors — queue Helius calls with concurrency limit
  const CONCURRENCY = 3;
  for (let i = 0; i < toPromote.length; i += CONCURRENCY) {
    const batch = toPromote.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async mint => {
      const nr = nursery.get(mint);
      if (!nr) return;
      nursery.delete(mint);
      try {
        await promoteFromNursery(mint, nr);
        promoted++;
      } catch (e) {
        console.error('Promote error:', nr.symbol, e.message);
        coldWatch.add(mint);
      }
    }));
  }

  if (purged > 0 || promoted > 0) {
    log('NURSERY_PURGE', 'system', 'system', {
      purged, promoted, nurseryRemaining: nursery.size,
      coldWatch: coldWatch.size, registry: registry.size,
    });
  }
}, NURSERY_PURGE_MS);

// ── Registry prune: remove inactive tokens every 5 min ───────────
setInterval(() => {
  const STALE_MS = 15 * 60_000;
  const now = Date.now();
  let pruned = 0;
  for (const [mint, token] of registry) {
    if ([STATE.HOLDING, STATE.EXIT_UNLOCKED, STATE.BUYING].includes(token.state)) continue;
    if (token.proven) continue;  // never prune proven tokens
    const lastTick = token.lastTickTs || token.createdAt || 0;
    if (now - lastTick > STALE_MS) {
      registry.delete(mint);
      pruned++;
    }
  }
  if (pruned > 0) log('PRUNE', 'system', 'system', { pruned, remaining: registry.size });

  // Mayhem sweep (firewall for tokens that stopped receiving ticks)
  let swept = 0;
  for (const [, token] of registry) {
    if (token.state === STATE.BLACKLISTED || token.state === STATE.CLOSED) continue;
    if (token.state === STATE.HOLDING || token.state === STATE.EXIT_UNLOCKED || token.state === STATE.BUYING) continue;
    if (token.mayhemDetected) {
      token.state = STATE.BLACKLISTED;
      token.stateChangedAt = Date.now();
      log('FIREWALL_SWEEP', token.symbol, token.mint, { reason: 'SWEEP: mayhem agent' });
      swept++;
    }
  }
  if (swept > 0) log('SWEEP', 'system', 'system', { swept });
}, 5 * 60_000);

// ── Watchdog: force-close zombie trades ──────────────────────────
function runWatchdog() {
  watchdogRuns++;

  // Timeout stale pending buys/sells (prevent permanent openCount leak)
  const now = Date.now();
  for (const [mint, pb] of pendingBuys) {
    if (!pb.queuedAt) pb.queuedAt = now;
    if (now - pb.queuedAt > PENDING_TIMEOUT_MS) {
      pendingBuys.delete(mint);
      openCount = Math.max(0, openCount - 1);
      pb.token.state = STATE.CLOSED;
      pb.token.cooldownUntil = now / 1000 + 30;
      log('PENDING_TIMEOUT', pb.token.symbol, mint, { type: 'buy', ageMs: now - pb.queuedAt, resetTo: 'CLOSED' });
      watchdogKills++;
    }
  }
  for (const [mint, ps] of pendingSells) {
    if (!ps.queuedAt) ps.queuedAt = now;
    if (now - ps.queuedAt > PENDING_TIMEOUT_MS) {
      pendingSells.delete(mint);
      openCount = Math.max(0, openCount - 1);
      ps.token.state = STATE.CLOSED;
      ps.token.cooldownUntil = now / 1000 + 30;
      ps.token.activeTrade = null;
      log('PENDING_TIMEOUT', ps.token.symbol, mint, { type: 'sell', ageMs: now - ps.queuedAt, resetTo: 'CLOSED' });
      watchdogKills++;
    }
  }

  for (const [, token] of registry) {
    if (token.state !== STATE.HOLDING && token.state !== STATE.EXIT_UNLOCKED) continue;
    const trade = token.activeTrade;
    if (!trade) continue;
    const holdSec = (Date.now() - trade.entryTs) / 1000;

    if (holdSec >= 10 && (trade.buyVol || 0) < 0.01) {
      console.log(`🐕 WATCHDOG: ${token.symbol} held ${holdSec.toFixed(0)}s with 0 buys — killing`);
      watchdogKills++;
      try {
        const event = forceClose(token, token.currentMc || 4000, log);
        if (event) { openCount = Math.max(0, openCount - 1); handleEvent(event).catch(() => {}); }
      } catch (e) { console.error('watchdog err:', e.message); }
      continue;
    }

    if (holdSec >= MAX_HOLD_SECS) {
      console.log(`🐕 WATCHDOG: ${token.symbol} hit max hold ${holdSec.toFixed(0)}s — killing`);
      watchdogKills++;
      try {
        const event = forceClose(token, token.currentMc || 4000, log);
        if (event) { openCount = Math.max(0, openCount - 1); handleEvent(event).catch(() => {}); }
      } catch (e) { console.error('watchdog err:', e.message); }
    }
  }
}
setInterval(runWatchdog, 5_000);
console.log('🐕 Watchdog started (5s interval)');

// ── Registry pruning: remove dead tokens to keep subscriptions manageable ──
function pruneDeadTokens() {
  const now = Date.now();
  const STALE_PRUNE_MS = 10 * 60_000;
  let pruned = 0;
  for (const [mint, token] of registry) {
    if (token.proven) continue;
    if (token.state === STATE.HOLDING || token.state === STATE.EXIT_UNLOCKED || token.state === STATE.BUYING) continue;
    if (token.activeTrade) continue;

    const lastTick = token.lastTickTs || token.stateChangedAt || 0;
    const staleDuration = now - lastTick;

    const isDead = staleDuration > STALE_PRUNE_MS && (
      token.state === STATE.WATCHING ||
      token.state === STATE.INDEXED ||
      (token.state === STATE.FLOORED && token.currentMc < 3000) ||
      token.state === STATE.BLACKLISTED
    );

    if (isDead) {
      registry.delete(mint);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`🧹 Pruned ${pruned} dead tokens from registry (${registry.size} remaining)`);
}
setInterval(pruneDeadTokens, 60_000);

// ── PP Re-subscribe: every 30s force re-sub active tokens (max 200) ──
setInterval(() => {
  if (!ppWs || ppWs.readyState !== 1) return;
  const activeMints = [];
  for (const [mint, token] of registry) {
    if ([STATE.BLACKLISTED, STATE.CLOSED].includes(token.state)) continue;
    activeMints.push(mint);
  }
  if (activeMints.length > 200) {
    activeMints.sort((a, b) => {
      const ta = registry.get(a), tb = registry.get(b);
      const pa = ['ARMED','HOLDING','EXIT_UNLOCKED','BUYING'].includes(ta?.state) ? 0 : 1;
      const pb = ['ARMED','HOLDING','EXIT_UNLOCKED','BUYING'].includes(tb?.state) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (tb?.currentMc || 0) - (ta?.currentMc || 0);
    });
    activeMints.length = 200;
  }
  if (activeMints.length > 0) {
    ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: activeMints }));
  }
}, 30_000);
console.log('🔄 PP re-subscribe every 30s (max 200 mints, prioritized)');

// ── Pump.fun API refresh: update stale tokens every 2 min ────────
async function refreshStaleTokens() {
  const now = Date.now();
  const STALE_THRESHOLD = 90_000;
  const toRefresh = [];

  for (const [mint, token] of registry) {
    if ([STATE.BLACKLISTED].includes(token.state)) continue;
    if (token.state === STATE.HOLDING || token.state === STATE.EXIT_UNLOCKED) continue;
    const lastTick = token.lastTickTs || 0;
    if (now - lastTick > STALE_THRESHOLD) {
      toRefresh.push(mint);
    }
  }

  if (toRefresh.length === 0) return;

  let refreshed = 0, migrated = 0, removed = 0, phantomRemoved = 0;
  for (const mint of toRefresh) {
    const token = registry.get(mint);
    if (!token) continue;

    try {
      const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) continue;
      const d = await r.json();

      // Migration detection — token left the bonding curve
      if (d.complete || d.raydium_pool) {
        log('MIGRATED', token.symbol, mint, {
          mc: Math.round(token.currentMc),
          realMc: Math.round(d.usd_market_cap || 0),
          dest: d.raydium_pool ? 'raydium' : 'graduated',
        });
        // Unsubscribe and remove — no point watching a migrated token on PP
        if (ppWs && ppWs.readyState === 1) {
          ppWs.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
        }
        registry.delete(mint);
        migrated++;
        continue;
      }

      // Phantom MC filter: real_sol_reserves near zero means MC is fake
      const realSolReserves = (d.real_sol_reserves || 0) / 1e9;
      if (realSolReserves < 0.01 && (d.usd_market_cap || 0) > 10_000) {
        log('PHANTOM_MC', token.symbol, mint, { mc: d.usd_market_cap, realSol: realSolReserves });
        registry.delete(mint);
        removed++;
        continue;
      }

      // Update MC from API
      const realMc = d.usd_market_cap || 0;
      if (realMc > 0 && realMc <= MC_BONDING_CURVE_MAX) {
        const oldMc = token.currentMc;
        token.currentMc = realMc;
        token.lastTickTs = now;

        // Update ATH from pump.fun (they track lifetime ATH)
        const realAth = d.ath_market_cap || 0;
        if (realAth > token.sessionHigh) {
          token.sessionHigh = realAth;
        }

        // Update session low if token dropped
        if (realMc < token.sessionLow && realMc > 0) {
          token.sessionLow = realMc;
        }

        // Feed a synthetic tick to the state machine
        const event = onTick(token, realMc, now, false, 0, openCount, false, log);
        if (event) handleEvent(event).catch(() => {});
        refreshed++;
      }
    } catch {}

    // Pace: 300ms between API calls
    await new Promise(r => setTimeout(r, 300));
  }

  if (refreshed > 0 || migrated > 0) {
    log('API_REFRESH', 'system', 'system', {
      refreshed, migrated,
      checked: toRefresh.length,
      registrySize: registry.size,
    });
  }
}
setInterval(() => refreshStaleTokens().catch(e => console.error('refresh err:', e.message)), 2 * 60_000);
setTimeout(() => refreshStaleTokens().catch(() => {}), 30_000);
console.log('🔄 Pump.fun API refresh every 2min for stale tokens');

// ── PP Heartbeat ─────────────────────────────────────────────────
setInterval(() => {
  const silence = Date.now() - lastPpMsg;
  if (silence > 30_000 && ppWs) {
    console.log(`💓 PP silent for ${(silence/1000).toFixed(0)}s — reconnecting`);
    try { ppWs.close(); } catch {}
  }
  if (!ppReady && silence > 10_000 && ppWs) {
    console.log('💓 PP not ready — forcing reconnect');
    try { ppWs.close(); } catch {}
  }
}, 15_000);

// ── State snapshot ───────────────────────────────────────────────
setInterval(saveSnapshot, SNAPSHOT_INTERVAL_MS);
console.log(`💾 Snapshots every ${SNAPSHOT_INTERVAL_MS/1000}s to ${DATA_DIR}`);
