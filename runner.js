/**
 * runner.js — I/O LAYER
 *
 * Handles everything external:
 *   - PumpPortal WebSocket (discovery + order book)
 *   - Helius (history loading, tx execution)
 *   - LaserStream (armed token feeds)
 *   - Express dashboard
 *
 * The runner feeds ticks to algo.js and executes the events it returns.
 * It never makes trading decisions. That's algo.js only.
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
const HELIUS_RPC    = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const PP_WS_URL     = 'wss://pumpportal.fun/api/data';

// ── Import algo ──────────────────────────────────────────────────
import { makeToken, onTick, confirmBuy, forceClose, updatePrice } from './algo.js';
import { runEntryGates, floorGate } from './gates.js';
import { UNLOCK_MC_USD, BUNDLE_TXN_THRESHOLD, BUNDLE_WINDOW_MS,
         QUALITY_MC_THRESHOLD, QUALITY_MAX_BUY_SOL,
         MAYHEM_AGENT_WALLET, STATE, POSITION_SOL } from './rules.js';

// ── Real trading imports (only if REAL_TRADING=true) ─────────────
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
const registry   = new Map();    // mint → token
const laserSlots = new Map();    // mint → cancel()
let   tradingHalted = process.env.START_HALTED === 'true';
let   openCount     = 0;
let   totalWins     = 0;
let   totalLosses   = 0;
let   totalFeesSol  = 0;
let   netPnlSol     = 0;
let   realWalletSol = null;
let   startingSol   = null;
let   solPrice      = 150;
let   ppWs          = null;
let   ppReady       = false;
const sseClients    = new Set();

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

// ── Helius: load history ──────────────────────────────────────────
// Mirrors the working approach from alligator2.4/auditEarlyTrades:
//   1. getSignaturesForAddress (raw RPC) → get all sigs
//   2. /v0/transactions (enhanced, no type filter) → parse enriched txs
//   3. Keep tx if source=PUMP_FUN OR type=SWAP (not URL-filtered — pump.fun
//      transactions sometimes have different type classifications)
const PUMP_PROGRAM_ID   = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_TOTAL_SUPPLY = 1_073_000_191; // actual pump.fun supply (6 decimals)

async function loadHistory(token) {
  if (!HELIUS_KEY) {
    token.historyLoaded = true;
    token.historyTrades = 0;
    return;
  }

  try {
    // Step 1: get all signatures for this mint address
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
      // Brand new token with no txns yet — mark loaded with 0 trades
      token.historyLoaded = true;
      token.historyTrades = 0;
      log('HISTORY_NEW', token.symbol, token.mint, {});
      return;
    }

    // Step 2: parse enriched transactions (no type filter in URL!)
    const txRes = await fetch(
      `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transactions: sigs.slice(0, 100) }),
        signal:  AbortSignal.timeout(15_000),
      }
    );
    if (!txRes.ok) {
      log('HISTORY_FAIL', token.symbol, token.mint, { error: `helius ${txRes.status}` });
      return;
    }
    const txs = await txRes.json();
    if (!Array.isArray(txs)) {
      log('HISTORY_FAIL', token.symbol, token.mint, { error: 'non-array' });
      return;
    }

    const allTrades = [];
    const historyBuyers = new Set();

    for (const tx of txs) {
      if (tx.transactionError) continue;
      // Keep pump.fun transactions regardless of type classification
      if (tx.source !== 'PUMP_FUN' && tx.type !== 'SWAP') continue;

      const tt  = tx.tokenTransfers || [];
      const nt  = tx.nativeTransfers || [];

      const tokOut = tt.find(t => t.mint === token.mint);
      if (!tokOut) continue;

      const tokAmt = tokOut.tokenAmount || 0;
      if (tokAmt <= 0) continue;

      // Largest native transfer = the SOL trade amount
      const solAmt = Math.max(...nt.map(n => (n.amount || 0)), 0) / 1e9;
      if (solAmt <= 0) continue;

      // Buy: tokens flow TO a non-program account
      // Sell: tokens flow FROM trader back to bonding curve (PUMP_PROGRAM_ID)
      const isBuy  = tokOut.toUserAccount !== PUMP_PROGRAM_ID;
      const trader = isBuy ? tokOut.toUserAccount : tokOut.fromUserAccount;

      // MC = price_per_token * total_supply * solPrice
      const mcSol = (solAmt / tokAmt) * PUMP_TOTAL_SUPPLY;
      const mcUsd = mcSol * solPrice;
      if (mcUsd <= 0 || mcUsd > 500_000) continue;

      allTrades.push({ ts: (tx.timestamp || 0) * 1000, isBuy, sol: solAmt, mc: mcUsd, trader });
    }

    // Sort chronologically (Helius returns newest-first)
    allTrades.sort((a, b) => a.ts - b.ts);

    // ── Bundle detection from history ────────────────────────────────
    // Two checks:
    // 1. Same wallet doing 6+ buys in 2s = single-wallet bundle
    // 2. 8+ buys from 3+ wallets in 3s = coordinated multi-wallet bundle
    if (allTrades.length >= 3) {
      const firstTs = allTrades[0].ts;

      // Check 1: single-wallet bundle
      const earlyBuys2s = allTrades.filter(t => t.isBuy && t.ts - firstTs < 2_000);
      const walletCounts = new Map();
      for (const t of earlyBuys2s) {
        if (t.trader) walletCounts.set(t.trader, (walletCounts.get(t.trader) || 0) + 1);
      }
      const maxSameWallet = Math.max(...walletCounts.values(), 0);
      if (maxSameWallet >= BUNDLE_TXN_THRESHOLD) {
        token.bundled       = true;
        token.bundleTxCount = maxSameWallet;
        log('BUNDLED_HISTORY', token.symbol, token.mint, {
          type: 'single-wallet', wallet: [...walletCounts.entries()].find(([,v]) => v === maxSameWallet)?.[0]?.slice(0,8),
          txns: maxSameWallet,
        });
      }

      // Check 2: multi-wallet coordinated burst
      const earlyBuys3s = allTrades.filter(t => t.isBuy && t.ts - firstTs < 3_000);
      const uniqueWallets = new Set(earlyBuys3s.map(t => t.trader).filter(Boolean));
      if (earlyBuys3s.length >= 8 && uniqueWallets.size >= 3) {
        token.bundled       = true;
        token.bundleTxCount = earlyBuys3s.length;
        log('BUNDLED_HISTORY', token.symbol, token.mint, {
          type: 'multi-wallet', txns: earlyBuys3s.length, wallets: uniqueWallets.size,
        });
      }
    }

    let count = 0;
    for (const { ts, isBuy, sol, mc, trader } of allTrades) {
      updatePrice(token, mc, ts || Date.now(), isBuy, sol);
      if (isBuy) {
        if (trader) historyBuyers.add(trader);
        if (mc < QUALITY_MC_THRESHOLD && sol > QUALITY_MAX_BUY_SOL) {
          token.maxEarlyBuySol = Math.max(token.maxEarlyBuySol, sol);
        }
      }
      count++;
    }

    // Freeze floor touches BEFORE mcHistory gets pruned by live ticks.
    // floorGate uses this to avoid losing historical evidence.
    if (token.sessionLow < Infinity) {
      const floor = token.sessionLow;
      token.historyFloorTouches = token.mcHistory.filter(h =>
        h.mc <= floor * 1.05 && h.mc >= floor * 0.95
      ).length;
    }

    // Persist buyer count before Set might be cleared
    token.resolvedBuyerCount = Math.max(
      historyBuyers.size,
      token.uniqueBuyers?.size || 0
    );

    token.historyLoaded = true;
    token.historyTrades = count;
    log('HISTORY_LOADED', token.symbol, token.mint, {
      trades:       count,
      sessionLow:   Math.round(token.sessionLow || 0),
      floorTouches: token.historyFloorTouches,
      buyers:       token.resolvedBuyerCount,
      liveSoFar:    token.liveTrades || 0,
    });

    // Immediately check if we have enough total data to advance.
    // For old/seeded coins with 0 Helius trades: live ticks will build history.
    // historyLoaded=true is already set above — liveTrades alone can satisfy the gate.
    if (token.state === STATE.WATCHING) {
      const totalKnown = count + (token.liveTrades || 0);
      const refMc      = token.currentMc > 0 ? token.currentMc
                       : token.sessionLow < Infinity ? token.sessionLow * 1.05
                       : 0;
      if (totalKnown >= HISTORY_MIN_TRADES && refMc > 0) {
        const event = onTick(token, refMc, Date.now(), false, 0, openCount, false, log);
        handleEvent(event).catch(() => {});
      }
    }
  } catch (e) {
    log('HISTORY_FAIL', token.symbol, token.mint, { error: e.message });
    // Do NOT set historyLoaded = true on failure. Token stays in WATCHING. No leaks.
  }
}

// ── Ensure token in registry ──────────────────────────────────────
async function ensureToken(mint, symbol, name, category) {
  if (registry.has(mint)) return registry.get(mint);
  const token = makeToken(mint, symbol || mint.slice(0,6), name || '', category || 'new');
  registry.set(mint, token);
  log('DISCOVERED', token.symbol, mint, { category });
  // Load history async — token stays in WATCHING until done
  loadHistory(token).catch(() => {});
  return token;
}

// ── Seed old coins ────────────────────────────────────────────────
// PumpPortal only pushes NEW token creates. For old coins with established
// floors we must explicitly subscribe. We fetch recently traded pump.fun
// tokens and seed the ones that look like they have price history.
async function seedOldCoins() {
  try {
    // Use pump.fun v3 API (v1 is Cloudflare-blocked from server IPs).
    // Sort by last_trade_timestamp DESC — most recently active coins.
    // We filter by ath_market_cap (peak MC) to find coins that actually pumped,
    // even if they're now back at floor — that's exactly our setup.
    const urls = [
      'https://frontend-api-v3.pump.fun/coins?limit=50&sort=last_trade_timestamp&order=DESC',
      'https://frontend-api-v3.pump.fun/coins?limit=50&sort=last_reply&order=DESC',
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
        if (!mint || registry.has(mint)) continue;

        // Skip graduated tokens (bonding curve full)
        const vSol = (c.virtual_sol_reserves || 0) / 1e9;
        if (vSol > 85) continue;

        // KEY FILTER: use ath_market_cap (all-time high MC) not current MC.
        // A coin that peaked at $20K and is now back at $4K floor is EXACTLY
        // what we want — but its current MC would fail a naive filter.
        const athMc = c.ath_market_cap || c.usd_market_cap || 0;
        if (athMc < 8_000) continue;  // ATH must have been at least $8K

        // Must be at least 10 min old — avoid competing with new-pair stream
        const ageMs = Date.now() - (c.created_timestamp || 0);
        if (ageMs < 10 * 60_000) continue;

        // Must have traded in the last 60 min — dead coins have no ticks,
        // no ticks = stuck in WATCHING forever, wastes a subscription slot
        const lastTradeMs = Date.now() - ((c.last_trade_timestamp || 0) * 1000);
        if (lastTradeMs > 60 * 60_000) continue;

        const token = await ensureToken(mint, c.symbol || mint.slice(0,6), c.name || '', 'old');
        token.isSeeded   = true;
        token.vSol       = vSol;
        // Seed the session high from ATH so the pump proof is already known
        if (c.ath_market_cap && c.ath_market_cap > (token.sessionHigh || 0)) {
          token.sessionHigh = c.ath_market_cap;
        }

        if (ppWs && ppWs.readyState === 1) {
          ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        }
        seeded++;

        if (seeded % 5 === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    log('SEED', 'system', 'system', { seeded, total: registry.size });
  } catch (e) {
    log('SEED_FAIL', 'system', 'system', { error: e.message });
  }
}

// ── LaserStream management ────────────────────────────────────────
async function activateLaser(token) {
  if (!REAL_TRADING || laserSlots.has(token.mint)) return;

  log('LASER_ON', token.symbol, token.mint, {});
  try {
    await armForMint(token.mint).catch(() => {});

    const [cancel] = await Promise.all([
      openLaserStream(token.mint, {
        endpoint: process.env.LASER_ENDPOINT || 'https://laserstream-mainnet-ewr.helius-rpc.com',
        apiKey:   HELIUS_KEY,
        onTrade: async (trade) => {
          const tok = registry.get(token.mint);
          if (!tok) { deactivateLaser(token.mint); return; }
          const mc = computeMc(trade, tok);
          const event = onTick(tok, mc, Date.now(), trade.isBuy, trade.solAmount, openCount, true, log);
          await handleEvent(event);
          if (tok.state !== STATE.ARMED && tok.state !== STATE.HOLDING &&
              tok.state !== STATE.EXIT_UNLOCKED && tok.state !== STATE.BUYING) {
            deactivateLaser(token.mint);
          }
        },
        onStatus: (s, detail) => {
          if (s === 'error') {
            log('LASER_ERR', token.symbol, token.mint, { detail });
            laserSlots.delete(token.mint);
            setTimeout(() => {
              const tok = registry.get(token.mint);
              if (tok && tok.state === STATE.ARMED && !laserSlots.has(tok.mint)) {
                activateLaser(tok).catch(() => {});
              }
            }, 2_000);
          }
        },
      }),
    ]);
    laserSlots.set(token.mint, cancel);
    console.log(`⚡ LASER LIVE [${token.symbol}]`);
  } catch (e) {
    log('LASER_FAIL', token.symbol, token.mint, { error: e.message });
  }
}

function deactivateLaser(mint) {
  const cancel = laserSlots.get(mint);
  if (!cancel) return;
  try { cancel(); } catch {}
  laserSlots.delete(mint);
  if (disarmMint) disarmMint(mint);
}

function computeMc(trade, token) {
  // Try to compute from trade price directly
  if (trade.priceSol) return trade.priceSol * 1_000_000_000 * solPrice;
  return token.currentMc || 0;
}

// ── Handle algo events ────────────────────────────────────────────
async function handleEvent(event) {
  if (!event) return;

  if (event.type === 'ARM') {
    broadcast({ type: 'armed', mint: event.token.mint, symbol: event.token.symbol });
    if (REAL_TRADING) await activateLaser(event.token).catch(() => {});
    return;
  }

  if (event.type === 'DISARM') {
    broadcast({ type: 'disarmed', mint: event.token.mint, symbol: event.token.symbol });
    if (REAL_TRADING) deactivateLaser(event.token.mint);
    return;
  }

  if (event.type === 'OPEN_TRADE') {
    if (tradingHalted) {
      log('TRADE_BLOCKED', event.token.symbol, event.token.mint, { reason: 'trading halted' });
      // Revert state
      event.token.state = STATE.ARMED;
      return;
    }
    openCount++;
    broadcast({ type: 'buy', mint: event.token.mint, symbol: event.token.symbol, mc: Math.round(event.token.currentMc) });

    if (REAL_TRADING) {
      try {
        const result = await executeBuy(event.token.mint, POSITION_SOL);
        const trade  = confirmBuy(event.token, event.token.currentMc, result.signature, result.tokensReceived, log);
        totalFeesSol += POSITION_SOL * 0.01;
        if (getSolBalance) getSolBalance().then(b => { realWalletSol = b; }).catch(() => {});
        log('BUY_REAL', event.token.symbol, event.token.mint, {
          sig: result.signature?.slice(0,12), entryMc: Math.round(event.token.currentMc),
        });
      } catch (e) {
        log('BUY_FAIL', event.token.symbol, event.token.mint, { error: e.message });
        event.token.state = STATE.ARMED;
        openCount--;
      }
    } else {
      // Paper trading — confirm immediately
      confirmBuy(event.token, event.token.currentMc, null, 0, log);
    }
    return;
  }

  if (event.type === 'CLOSE_TRADE') {
    const { token, trade, reason, exitMc } = event;
    openCount = Math.max(0, openCount - 1);

    if (trade) {
      const isWin = trade.pnlPct > 0;
      if (isWin) totalWins++; else totalLosses++;
      netPnlSol += (POSITION_SOL * trade.pnlPct / 100);
      totalFeesSol += POSITION_SOL * 0.01;
    }

    broadcast({ type: 'sell', mint: token.mint, symbol: token.symbol,
      pnl: trade?.pnlPct?.toFixed(2), reason, exitMc: Math.round(exitMc) });

    if (REAL_TRADING) {
      retrySell(token.mint, token.symbol).then(result => {
        log('SELL_REAL', token.symbol, token.mint, {
          sig: result.signature?.slice(0,12), solReceived: result.solReceived,
          paperPnl: trade?.pnlPct?.toFixed(2), reason,
        });
        if (getSolBalance) getSolBalance().then(b => { realWalletSol = b; }).catch(() => {});
      }).catch(e => {
        log('SELL_FAIL', token.symbol, token.mint, { error: e.message });
      });
    }
  }
}

// ── Retry sell ────────────────────────────────────────────────────
async function retrySell(mint, symbol) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await executeSell(mint);
    } catch (e) {
      log('SELL_RETRY', symbol, mint, { attempt, error: e.message });
      if (attempt < 4) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw new Error('sell failed after 4 attempts');
}

// ── PumpPortal WebSocket ──────────────────────────────────────────
function connectPP() {
  console.log('📡 Connecting to PumpPortal...');
  ppWs = new WebSocket(PP_WS_URL);

  ppWs.on('open', () => {
    ppReady = true;
    console.log('✅ PumpPortal connected');
    ppWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  // Keep last 10 PP messages for diagnostics (no sensitive data)
  const ppMsgLog = [];

  ppWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Track recent messages globally for /api/diag
    if (!global._ppMsgLog) global._ppMsgLog = [];
    global._ppMsgLog.unshift({
      txType: msg.txType,
      symbol: msg.symbol || msg.mint?.slice(0,6),
      marketCapSol: msg.marketCapSol,
      solAmount: msg.solAmount,
      ts: Date.now(),
    });
    if (global._ppMsgLog.length > 20) global._ppMsgLog.length = 20;

    // ── New token ─────────────────────────────────────────────
    if (msg.txType === 'create') {
      const mint   = msg.mint;
      const symbol = msg.symbol || mint.slice(0,6);
      const token  = await ensureToken(mint, symbol, msg.name, 'new');

      // Subscribe to trades on this token
      ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));

      // Bundle detection
      if (!token._bundleWindow) {
        token._bundleWindow = { start: Date.now(), count: 0 };
      }

      return;
    }

    // ── Token trade ───────────────────────────────────────────
    const mint = msg.mint;
    if (!mint) return;

    let token = registry.get(mint);
    if (!token) {
      // Old pair we haven't seen — seed it
      const category = (msg.vSolInBondingCurve || 0) >= 85 ? 'migrated' : 'old';
      token = await ensureToken(mint, msg.symbol, msg.name, category);
      ppWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }

    const isBuy    = msg.txType === 'buy';
    const sol      = msg.solAmount || 0;
    const vSol     = msg.vSolInBondingCurve || 0;

    // PumpPortal sends marketCapSol directly — use it, don't recompute.
    // Old code computed from vSol/tokenAmount which was dimensionally wrong.
    const mc       = (msg.marketCapSol || 0) * solPrice;

    if (mc <= 0) return;

    // Always update pool size on every tick — quality gate needs this
    token.vSol = vSol;

    // Quality tracking (new pairs only)
    if (token.category === 'new' && isBuy && msg.traderPublicKey) {
      if (token.uniqueBuyers) token.uniqueBuyers.add(msg.traderPublicKey);
      if (mc < QUALITY_MC_THRESHOLD && sol > QUALITY_MAX_BUY_SOL) {
        token.maxEarlyBuySol = Math.max(token.maxEarlyBuySol, sol);
        log('QUALITY_FAIL', token.symbol, mint, { sol: sol.toFixed(2), mc: Math.round(mc) });
      }
    }

    // Mayhem detection
    if (msg.traderPublicKey === MAYHEM_AGENT_WALLET) {
      token.mayhemDetected = true;
    }

    // Bundle detection — two methods:
    // 1. Create-window: same wallet doing 6+ buys in 1.5s (existing)
    // 2. Burst detection: ANY 8+ trades in first 3s of token life = coordinated launch
    if (token._bundleWindow) {
      const age = Date.now() - token._bundleWindow.start;
      if (age < BUNDLE_WINDOW_MS) {
        token._bundleWindow.count++;
        if (token._bundleWindow.count >= BUNDLE_TXN_THRESHOLD) {
          token.bundled       = true;
          token.bundleTxCount = token._bundleWindow.count;
          log('BUNDLED', token.symbol, mint, { txns: token.bundleTxCount });
        }
      } else {
        delete token._bundleWindow;
      }
    }

    // Burst detection: track first 3 seconds of observed trading
    if (!token._burstWindow) {
      token._burstWindow = { start: Date.now(), count: 1, wallets: new Set() };
      if (msg.traderPublicKey) token._burstWindow.wallets.add(msg.traderPublicKey);
    } else if (token._burstWindow) {
      const burstAge = Date.now() - token._burstWindow.start;
      if (burstAge < 3_000) {
        token._burstWindow.count++;
        if (msg.traderPublicKey) token._burstWindow.wallets.add(msg.traderPublicKey);
        // 8+ trades in 3s with 3+ different wallets = coordinated multi-wallet bundle
        if (token._burstWindow.count >= 8 && token._burstWindow.wallets.size >= 3) {
          token.bundled       = true;
          token.bundleTxCount = token._burstWindow.count;
          log('BUNDLED_BURST', token.symbol, mint, {
            txns: token._burstWindow.count,
            wallets: token._burstWindow.wallets.size,
            windowMs: burstAge,
          });
        }
      } else {
        delete token._burstWindow;
      }
    }

    // Feed tick to algo — NOT laser stream
    const event = onTick(token, mc, Date.now(), isBuy, sol, openCount, false, log);
    await handleEvent(event);
  });

  ppWs.on('close', () => {
    ppReady = false;
    console.log('🔌 PumpPortal disconnected — reconnecting in 3s...');
    setTimeout(connectPP, 3_000);
  });

  ppWs.on('error', e => console.error('⚠️  PP error:', e.message));
}

// ── SOL price updater ─────────────────────────────────────────────
async function refreshSolPrice() {
  try {
    const r = await fetch('https://price.jup.ag/v6/price?ids=SOL', { signal: AbortSignal.timeout(5_000) });
    const d = await r.json();
    solPrice = d?.data?.SOL?.price || solPrice;
  } catch {}
}
setInterval(refreshSolPrice, 30_000);
refreshSolPrice();

// ── Wallet balance ────────────────────────────────────────────────
async function refreshWallet() {
  if (!REAL_TRADING || !getSolBalance) return;
  try {
    const bal = await getSolBalance();
    realWalletSol = bal;
    if (startingSol === null) {
      startingSol = bal;
      console.log(`💰 Starting wallet: ${bal.toFixed(4)} SOL`);
    }
  } catch {}
}
if (REAL_TRADING) { refreshWallet(); setInterval(refreshWallet, 15_000); }

// ── Express dashboard ─────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve dashboard HTML
app.get('/', (_req, res) => {
  const tokens = [...registry.values()];
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>2Wallets Algo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: 'SF Mono', monospace; font-size: 13px; }
    .topbar { background: #111; border-bottom: 1px solid #1e1e1e; padding: 12px 20px; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
    .topbar h1 { color: #fff; font-size: 16px; margin-right: 8px; }
    .stat { text-align: center; min-width: 80px; }
    .stat .val { font-size: 20px; font-weight: 700; }
    .stat .lbl { font-size: 10px; color: #555; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
    .green { color: #4fc; } .red { color: #f55; } .yellow { color: #fc4; } .blue { color: #59f; }
    .actions { margin-left: auto; display: flex; gap: 8px; }
    .btn { padding: 6px 14px; border-radius: 5px; border: none; cursor: pointer; font-size: 12px; font-weight: 600; }
    .btn-stop  { background: #f55; color: #000; }
    .btn-start { background: #4fc; color: #000; }
    .main { display: grid; grid-template-columns: 320px 1fr; height: calc(100vh - 57px); }
    .sidebar { border-right: 1px solid #1e1e1e; overflow-y: auto; padding: 12px; }
    .content { overflow-y: auto; padding: 12px; }
    .section-title { font-size: 11px; color: #444; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #1a1a1a; }
    .trade-card { background: #141414; border: 1px solid #1e1e1e; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
    .trade-card.win  { border-left: 3px solid #4fc; }
    .trade-card.loss { border-left: 3px solid #f55; }
    .trade-card.open { border-left: 3px solid #fc4; }
    .token-row { padding: 6px 8px; border-radius: 4px; margin-bottom: 4px; background: #111; cursor: pointer; display: flex; gap: 8px; align-items: center; font-size: 12px; position: relative; }
    .token-row:hover { background: #181818; }
    .token-row:hover .copy-hint { opacity: 1; }
    .copy-hint { opacity: 0; font-size: 9px; color: #444; transition: opacity 0.15s; }
    .token-row.copied { background: #0d1f0d !important; }
    .token-row.copied .copy-hint { opacity: 1; color: #4fc; }
    .state-badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #222; }
    .state-ARMED       { background: #1a2a1a; color: #4fc; }
    .state-HOLDING     { background: #2a2a10; color: #fc4; }
    .state-EXIT_UNLOCKED { background: #2a1a1a; color: #f95; }
    .state-INDEXED     { background: #1a1a2a; color: #59f; }
    .state-FLOORED     { background: #1a2020; color: #4dd; }
    #feed { font-size: 11px; color: #555; height: 200px; overflow-y: auto; padding: 8px; background: #0d0d0d; border-radius: 4px; border: 1px solid #1a1a1a; }
    #feed .entry { padding: 2px 0; border-bottom: 1px solid #111; }
    #status-bar { position: fixed; bottom: 0; right: 0; background: #111; padding: 4px 12px; font-size: 10px; color: #333; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>2Wallets Algo <span id="ver" style="color:#333;font-size:11px">v1.0</span></h1>
    <div class="stat"><div class="val" id="wallet-sol">—</div><div class="lbl">Wallet SOL</div></div>
    <div class="stat"><div class="val green" id="net-pnl">—</div><div class="lbl">Net PnL SOL</div></div>
    <div class="stat"><div class="val" id="trades">—</div><div class="lbl">Trades</div></div>
    <div class="stat"><div class="val green" id="wr">—</div><div class="lbl">Win Rate</div></div>
    <div class="stat"><div class="val yellow" id="open">—</div><div class="lbl">Open</div></div>
    <div class="stat"><div class="val blue" id="armed">—</div><div class="lbl">Armed</div></div>
    <div class="stat"><div class="val" id="tokens">—</div><div class="lbl">Tokens</div></div>
    <div class="actions">
      <button class="btn btn-stop"  onclick="halt()">⛔ STOP</button>
      <button class="btn btn-start" onclick="resume()">▶ RESUME</button>
    </div>
  </div>
  <div class="main">
    <div class="sidebar">
      <div class="section-title">Active Tokens</div>
      <div id="token-list"></div>
      <div class="section-title" style="margin-top:16px">Live Feed</div>
      <div id="feed"></div>
    </div>
    <div class="content">
      <div class="section-title">Open Trades</div>
      <div id="open-trades"></div>
      <div class="section-title" style="margin-top:16px">Closed Trades</div>
      <div id="closed-trades"></div>
    </div>
  </div>
  <div id="status-bar">Connecting...</div>

  <script>
    async function halt()   { await fetch('/api/stop',   {method:'POST'}); }
    async function resume() { await fetch('/api/resume', {method:'POST'}); }

    // Delegated click — reads mint from data-mint at click time, never stale
    document.getElementById('token-list').addEventListener('click', (e) => {
      const row = e.target.closest('.token-row');
      if (!row) return;
      const mint = row.dataset.mint;
      if (!mint) return;
      navigator.clipboard.writeText(mint).then(() => {
        row.classList.add('copied');
        row.querySelector('.copy-hint').textContent = '✓ copied';
        setTimeout(() => {
          row.classList.remove('copied');
          const hint = row.querySelector('.copy-hint');
          if (hint) hint.textContent = 'copy CA';
        }, 1500);
      });
    });

    async function refresh() {
      const [s, ct] = await Promise.all([fetch('/api/stats'), fetch('/api/closed')]);
      const stats  = await s.json();
      const closed = await ct.json();

      document.getElementById('wallet-sol').textContent = (stats.walletSol ?? '—');
      document.getElementById('net-pnl').textContent    = (stats.netPnlSol >= 0 ? '+' : '') + (stats.netPnlSol ?? 0).toFixed(4);
      document.getElementById('net-pnl').className      = 'val ' + (stats.netPnlSol >= 0 ? 'green' : 'red');
      document.getElementById('trades').textContent     = stats.trades + ' W:' + stats.wins + ' L:' + stats.losses;
      document.getElementById('wr').textContent         = stats.winRate ? stats.winRate + '%' : '—';
      document.getElementById('open').textContent       = stats.open;
      document.getElementById('armed').textContent      = stats.armed;
      document.getElementById('tokens').textContent     = stats.tokens;

      // Token list
      const tl = document.getElementById('token-list');
      tl.innerHTML = (stats.activeTokens || []).map(t => \`
        <div class="token-row" data-mint="\${t.mint}" title="\${t.mint}">
          <span>\${t.symbol}</span>
          <span class="state-badge state-\${t.state}">\${t.state}</span>
          <span style="color:#666;margin-left:auto">\$\${(t.mc||0).toLocaleString()}</span>
          <span class="copy-hint">copy CA</span>
        </div>\`).join('');

      // Closed trades
      const cd = document.getElementById('closed-trades');
      cd.innerHTML = closed.slice().reverse().slice(0,50).map(t => \`
        <div class="trade-card \${t.pnlPct > 0 ? 'win' : 'loss'}">
          <div style="display:flex;gap:12px">
            <span style="color:#fff;font-weight:600">\${t.symbol}</span>
            <span style="color:\${t.pnlPct>0?'#4fc':'#f55'}">\${t.pnlPct>0?'+':''}\${t.pnlPct?.toFixed(1)}%</span>
            <span style="color:#555">\${t.holdSec?.toFixed(0)}s</span>
            <span style="color:#444">\${t.reason}</span>
            <span style="color:#333;margin-left:auto">\$\${(t.entryMc||0).toLocaleString()} → \$\${(t.exitMc||0).toLocaleString()}</span>
          </div>
        </div>\`).join('');

      document.getElementById('status-bar').textContent = 'Last update: ' + new Date().toLocaleTimeString() + (stats.halted ? ' | HALTED' : ' | LIVE');
    }

    // SSE for live feed
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      const feed = document.getElementById('feed');
      const el = document.createElement('div');
      el.className = 'entry';
      el.textContent = new Date().toLocaleTimeString() + ' ' + JSON.stringify(d);
      feed.prepend(el);
      if (feed.children.length > 100) feed.lastChild.remove();
    };

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
  res.send(html);
});

// ── API endpoints ────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  const tokens      = [...registry.values()];
  const armed       = tokens.filter(t => t.state === STATE.ARMED).length;
  const open        = tokens.filter(t => t.state === STATE.HOLDING || t.state === STATE.EXIT_UNLOCKED || t.state === STATE.BUYING).length;
  const trades      = totalWins + totalLosses;

  // State breakdown (debug — inline so no extra route needed)
  const byState = {};
  for (const t of tokens) byState[t.state] = (byState[t.state] || 0) + 1;

  const activeTokens = tokens
    .filter(t => ![STATE.WATCHING, STATE.BLACKLISTED].includes(t.state))
    .slice(0, 50)
    .map(t => ({
      symbol: t.symbol, mint: t.mint, state: t.state,
      mc: Math.round(t.currentMc),
      high: Math.round(t.sessionHigh),
      floor: Math.round(t.sessionLow < Infinity ? t.sessionLow : 0),
      histTrades: t.historyTrades,
      floorTouches: Math.max(t.historyFloorTouches || 0, t.confirmedFloorTouches || 0, t.floorTouches || 0),
      buyers: Math.max(t.uniqueBuyers?.size ?? 0, t.resolvedBuyerCount ?? 0),
      liveTrades: t.liveTrades || 0,
      gateFail: t.lastGateFail || null,
      category: t.category,
    }));

  // Sample of stuck WATCHING tokens for diagnosis
  const watchingSample = tokens
    .filter(t => t.state === STATE.WATCHING)
    .slice(0, 5)
    .map(t => ({
      symbol:    t.symbol,
      histLoaded: t.historyLoaded,
      histTrades: t.historyTrades,
      liveTrades: t.liveTrades || 0,
      total:     (t.historyTrades || 0) + (t.liveTrades || 0),
    }));

  res.json({
    version:    '1.1.0',
    realTrading: REAL_TRADING,
    halted:     tradingHalted,
    walletSol:  realWalletSol?.toFixed(4) ?? null,
    startingSol: startingSol?.toFixed(4) ?? null,
    netPnlSol:  +netPnlSol.toFixed(4),
    trades, wins: totalWins, losses: totalLosses,
    winRate:    trades > 0 ? +(totalWins / trades * 100).toFixed(1) : null,
    open, armed,
    tokens:     tokens.length,
    ppConnected: ppReady,
    laserSlots: laserSlots.size,
    byState, activeTokens, watchingSample,
  });
});

// Full registry dump — useful for diagnosing discovery issues
app.get('/api/registry', (_req, res) => {
  const all = [...registry.values()].map(t => ({
    symbol: t.symbol, mint: t.mint, state: t.state, category: t.category,
    mc: Math.round(t.currentMc || 0),
    ath: Math.round(t.sessionHigh || 0),
    floor: Math.round(t.sessionLow < Infinity ? t.sessionLow : 0),
    buyers: Math.max(t.uniqueBuyers?.size ?? 0, t.resolvedBuyerCount ?? 0),
    histLoaded: t.historyLoaded, histTrades: t.historyTrades,
    liveTrades: t.liveTrades || 0, isSeeded: t.isSeeded || false,
    lastTick: t.lastTickTs ? Math.round((Date.now() - t.lastTickTs) / 1000) + 's ago' : 'never',
  })).sort((a, b) => b.ath - a.ath);
  res.json(all);
});

app.get('/api/closed', (_req, res) => {
  const all = [];
  for (const token of registry.values()) {
    for (const t of token.closedTrades) all.push({ ...t, symbol: token.symbol, mint: token.mint });
  }
  all.sort((a, b) => b.exitTs - a.exitTs);
  res.json(all.slice(0, 200));
});

// Debug endpoint — shows state breakdown for all tokens
app.get('/api/debug', (_req, res) => {
  const tokens = [...registry.values()];
  const byState = {};
  for (const t of tokens) {
    byState[t.state] = (byState[t.state] || 0) + 1;
  }
  const samples = tokens
    .filter(t => t.state !== STATE.WATCHING)
    .slice(0, 20)
    .map(t => ({
      symbol:        t.symbol,
      state:         t.state,
      mc:            Math.round(t.currentMc),
      sessionLow:    Math.round(t.sessionLow < Infinity ? t.sessionLow : 0),
      histLoaded:    t.historyLoaded,
      histTrades:    t.historyTrades,
      floorTouches:  t.historyFloorTouches || 0,
      floorTouchesLive: t.floorTouches || 0,
      category:      t.category,
    }));
  const watching = tokens
    .filter(t => t.state === STATE.WATCHING)
    .slice(0, 5)
    .map(t => ({ symbol: t.symbol, histLoaded: t.historyLoaded, histTrades: t.historyTrades }));
  res.json({ byState, samples, watchingSample: watching });
});

// PP message diagnostic — helps trace why mc=0
app.get('/api/diag', (_req, res) => {
  res.json({ note: 'use /api/stats byState for state info', ppMsgLog: global._ppMsgLog || [] });
});

app.get('/api/gates', (_req, res) => {
  const openCount = [...registry.values()].filter(t => t.activeTrade).length;
  const results = [];

  for (const token of registry.values()) {
    if (token.state === 'ARMED' || token.state === 'FLOORED') {
      const floor = token.sessionLow;
      const aboveFloor = floor > 0 ? ((token.currentMc - floor) / floor * 100).toFixed(1) : 'N/A';
      const hasRealPump = token.sessionHigh > floor * 1.10;

      const entry = {
        symbol:    token.symbol,
        state:     token.state,
        mc:        Math.round(token.currentMc),
        high:      Math.round(token.sessionHigh),
        floor:     Math.round(floor),
        aboveFloor: aboveFloor + '%',
        hasRealPump,
        buyers:    token.uniqueBuyers?.size ?? token.resolvedBuyerCount ?? 0,
        hist:      token.historyTrades,
        live:      token.liveTrades || 0,
        touches:   token.floorTouches,
        histTouches: token.historyFloorTouches || 0,
        vSol:      token.vSol,
      };

      if (token.state === 'ARMED') {
        // Simulate a 0.15 SOL buy catalyst at current price
        const gates = runEntryGates(token, true, 0.15, token.currentMc, openCount, () => {});
        entry.gates = gates;
      }

      if (token.state === 'FLOORED') {
        const fg = floorGate(token);
        entry.floorGate = fg;
      }

      results.push(entry);
    }
  }

  res.json({ openCount, count: results.length, tokens: results.slice(0, 15) });
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/stop', (_req, res) => {
  tradingHalted = true;
  // Force close all open trades
  for (const token of registry.values()) {
    if (token.activeTrade || token.state === STATE.BUYING) {
      const event = forceClose(token, token.currentMc, log);
      handleEvent(event).catch(() => {});
    }
    if (token.state === STATE.ARMED) {
      token.state = STATE.FLOORED;
      if (REAL_TRADING) deactivateLaser(token.mint);
    }
  }
  log('HALTED', 'system', 'system', {});
  broadcast({ type: 'halted' });
  res.json({ ok: true, halted: true });
});

app.post('/api/resume', (_req, res) => {
  tradingHalted = false;
  log('RESUMED', 'system', 'system', {});
  broadcast({ type: 'resumed' });
  res.json({ ok: true, halted: false });
});

// ── Start ─────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`\n🐊 2Wallets Algo v1.1 — port ${PORT}`);
  console.log(`📁 Logging to: ${LOG_FILE}`);
  console.log(`⚡ Real trading: ${REAL_TRADING}`);
  console.log(`🔒 Start halted: ${tradingHalted}`);
  console.log();
});

connectPP();

// Seed old coins 5s after startup (so PP WS is open first)
// then refresh every 3 minutes to catch newly active tokens
setTimeout(() => {
  seedOldCoins().catch(() => {});
  setInterval(() => seedOldCoins().catch(() => {}), 3 * 60_000);
}, 5_000);

// Prune dead tokens every 5 minutes
// Remove tokens with no ticks for 15+ min that aren't in an active trade
setInterval(() => {
  const STALE_MS = 15 * 60_000;
  const now = Date.now();
  let pruned = 0;
  for (const [mint, token] of registry) {
    if ([STATE.HOLDING, STATE.EXIT_UNLOCKED, STATE.BUYING].includes(token.state)) continue;
    const lastTick = token.lastTickTs || token.createdAt || 0;
    if (now - lastTick > STALE_MS) {
      registry.delete(mint);
      pruned++;
    }
  }
  if (pruned > 0) log('PRUNE', 'system', 'system', { pruned, remaining: registry.size });
}, 5 * 60_000);
