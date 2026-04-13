#!/bin/bash
# 10-SESSION TRAINING LOOP — 150 minutes total
# Each session: 15 min paper trading → comprehensive review → patch → deploy → next
set -euo pipefail

BASE_URL="${BOT_URL:-https://2wallets-algo-production.up.railway.app}"
RAILWAY_TOKEN="cf9be67f-d971-47b2-8930-1e9bc04ec28a"
SERVICE_ID="6f0b6c01-03c6-44ab-a2f5-d873fe14e733"
ENV_ID="003346eb-87a1-4979-bb02-af53883f1a98"
DATA_DIR="$(dirname "$0")/data"
REPO_DIR="$(dirname "$0")"
mkdir -p "$DATA_DIR"

LOG="$DATA_DIR/training_10x15_$(date +%Y-%m-%dT%H-%M-%S).log"
LIVE_LOG="$DATA_DIR/training_10x15_live.log"
SESSION_SEC=900  # 15 min
TOTAL_SESSIONS=10

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$LOG"
  echo "$msg" >> "$LIVE_LOG"
}

api() {
  curl -sf --max-time 15 -H "User-Agent: Mozilla/5.0" "${BASE_URL}${1}" 2>/dev/null || echo '{"_error":"failed"}'
}

deploy() {
  local sha="$1"
  log "Deploying $sha..."
  local result=$(curl -sf --max-time 30 -X POST 'https://backboard.railway.com/graphql/v2' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $RAILWAY_TOKEN" \
    -d "{\"query\":\"mutation { serviceInstanceDeployV2(serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\", commitSha: \\\"$sha\\\") }\"}" 2>/dev/null || echo '{"_error":"deploy failed"}')
  log "Deploy result: $result"
  # Wait for deploy
  for i in $(seq 1 12); do
    sleep 10
    local v=$(curl -sf --max-time 5 "${BASE_URL}/api/stats" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('version','?'))" 2>/dev/null || echo "offline")
    log "  Deploy check $i: version=$v"
    if echo "$v" | grep -q "$(cd "$REPO_DIR" && python3 -c "
import re, sys
with open('runner.js') as f:
  m = re.search(r\"version.*?'([\d.]+)'\", f.read())
  print(m.group(1) if m else '?')
" 2>/dev/null)"; then
      log "  Deploy confirmed!"
      return 0
    fi
  done
  log "  Deploy may have failed — continuing anyway"
  return 0
}

snapshot() {
  local label="$1"
  log "[$label] Snapshot:"
  api "/api/stats" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  print(f'  Version: {d.get(\"version\",\"?\")}')
  print(f'  Registry: {d.get(\"tokens\",\"?\")} | Nursery: {d.get(\"nurserySize\",\"?\")} | ColdWatch: {d.get(\"coldWatchSize\",\"?\")}')
  print(f'  Armed: {d.get(\"armed\",0)} | Open: {d.get(\"open\",0)} | Trades: {d.get(\"trades\",0)}')
  print(f'  Wins: {d.get(\"wins\",0)} | Losses: {d.get(\"losses\",0)} | WR: {d.get(\"winRate\",0)}%')
  print(f'  PnL: {d.get(\"netPnlSol\",0):.4f} SOL')
  print(f'  Proven: {d.get(\"provenTokens\",0)} | MaxConcurrent: {d.get(\"maxConcurrent\",\"?\")}')
  print(f'  States: {d.get(\"byState\",{})}')
  print(f'  PP: {d.get(\"ppConnected\",False)}')
except: print('  Error parsing stats')
" 2>/dev/null | tee -a "$LOG"
}

wallet_compare() {
  log "Wallet comparison:"
  api "/api/wallet-compare" | python3 -c "
import json,sys
try:
  data=json.load(sys.stdin)
  if not data:
    print('  No tracked wallet activity on our coins yet')
  else:
    for c in data[:10]:
      wbuys = c.get('walletBuys',0)
      wsells = c.get('walletSells',0)
      obuys = c.get('ourBuys',0)
      osells = c.get('ourSells',0)
      print(f'  {c[\"symbol\"]} ({c[\"mint\"][:8]}): Wallets {wbuys}B/{wsells}S | Us {obuys}B/{osells}S | MC \${c[\"mc\"]} | ATH \${c[\"ath\"]} | State: {c[\"state\"]}')
      for wt in c.get('walletTrades',[])[:5]:
        side = 'BUY' if wt['isBuy'] else 'SELL'
        print(f'    {wt[\"wallet\"]} {side} {wt[\"sol\"]:.3f} SOL @ \${wt[\"mc\"]} (our state: {wt.get(\"state\",\"?\")}, our floor: \${wt.get(\"ourFloor\",0)})')
except: print('  Error parsing wallet data')
" 2>/dev/null | tee -a "$LOG"
}

review_trades() {
  log "Trade review:"
  api "/api/trades" | python3 -c "
import json,sys
try:
  trades=json.load(sys.stdin)
  if not trades:
    print('  NO TRADES — this is a problem if tokens are arming')
    return
  wins = [t for t in trades if t.get('pnlPct',0) > 0]
  losses = [t for t in trades if t.get('pnlPct',0) <= 0]
  print(f'  Total: {len(trades)} | Wins: {len(wins)} | Losses: {len(losses)}')
  for t in trades[-10:]:
    pnl = t.get('pnlPct',0)
    sym = t.get('symbol','?')
    entry = t.get('entryMc',0)
    exit_mc = t.get('exitMc',0)
    reason = t.get('reason','?')
    hold = t.get('holdSec',0)
    sign = '+' if pnl > 0 else ''
    print(f'  {sym}: \${entry}→\${exit_mc} {sign}{pnl:.1f}% ({reason}, {hold:.0f}s)')
except: print('  No trade data available')
" 2>/dev/null | tee -a "$LOG"
}

audit_gates() {
  log "Gate audit:"
  api "/api/audit" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  blocked = d.get('blockedAudit',[])
  armed = d.get('armedAudit',[])
  violations = [a for a in armed if not a.get('allGatesPass')]
  print(f'  Pipeline: {len(blocked)} blocked | {len(armed)} armed')
  if violations:
    for v in violations:
      print(f'  !! GATE VIOLATION: {v.get(\"symbol\")} - {v.get(\"failedGate\")}')
  floored_ready = [b for b in blocked if b.get('state')=='FLOORED' and b.get('floorGatePass') and b.get('mc',0) > 4000]
  if floored_ready:
    for f in floored_ready[:5]:
      print(f'  FLOORED & READY: {f[\"symbol\"]} MC=\${f[\"mc\"]} floor=\${f[\"floor\"]} aboveFloor={f.get(\"aboveFloorPct\",0)}%')
  indexed_stale = [b for b in blocked if b.get('state')=='INDEXED' and b.get('mc',0) > 5000]
  if indexed_stale:
    print(f'  INDEXED >$5K (need floor): {len(indexed_stale)} tokens')
    for s in indexed_stale[:3]:
      print(f'    {s[\"symbol\"]} MC=\${s[\"mc\"]}')
except: print('  Audit endpoint not available')
" 2>/dev/null | tee -a "$LOG"
}

review_registry() {
  log "Registry health:"
  api "/api/registry" | python3 -c "
import json,sys
try:
  tokens=json.load(sys.stdin)
  by_state = {}
  proven_tokens = []
  for t in tokens:
    s = t.get('state','?')
    by_state[s] = by_state.get(s, 0) + 1
    if t.get('winCount',0) >= 1:
      proven_tokens.append(t)
  print(f'  Total: {len(tokens)} | States: {by_state}')
  high_mc = [t for t in tokens if t.get('mc',0) > 10000]
  if high_mc:
    print(f'  High MC tokens (>\$10K):')
    for t in high_mc[:5]:
      print(f'    {t[\"symbol\"]} MC=\${t[\"mc\"]} ATH=\${t[\"ath\"]} State={t[\"state\"]} Trades={t.get(\"tradeCount\",0)} Wins={t.get(\"winCount\",0)}')
  if proven_tokens:
    print(f'  Proven tokens ({len(proven_tokens)}):')
    for t in proven_tokens[:5]:
      print(f'    {t[\"symbol\"]} Wins={t[\"winCount\"]} Trades={t[\"tradeCount\"]} MC=\${t[\"mc\"]}')
except: print('  Error parsing registry')
" 2>/dev/null | tee -a "$LOG"
}

#####################################################################
log "╔══════════════════════════════════════════════════════════════╗"
log "║  10-SESSION TRAINING LOOP — 150 MIN TOTAL                  ║"
log "║  Bot: $BASE_URL                                            ║"
log "╚══════════════════════════════════════════════════════════════╝"
snapshot "INIT"

for session in $(seq 1 $TOTAL_SESSIONS); do
  log ""
  log "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓"
  log "  SESSION $session / $TOTAL_SESSIONS — STARTING ($(date))"
  log "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓"

  session_start=$(date +%s)
  session_end=$((session_start + SESSION_SEC))

  # Monitor during session — check every 3 min
  check=0
  while [ "$(date +%s)" -lt "$session_end" ]; do
    check=$((check + 1))
    remaining=$(( (session_end - $(date +%s)) / 60 ))
    log "  [S${session}] Check #${check} — ${remaining}min left"
    snapshot "S${session}-C${check}"
    wallet_compare
    sleep 180
  done

  # ── END OF SESSION: COMPREHENSIVE REVIEW ──
  log ""
  log "════════════ SESSION $session REVIEW ════════════"
  snapshot "S${session}-END"
  review_trades
  audit_gates
  review_registry
  wallet_compare

  log ""
  log "═══ SESSION $session SUMMARY ═══"
  api "/api/stats" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  trades = d.get('trades',0)
  wins = d.get('wins',0)
  losses = d.get('losses',0)
  pnl = d.get('netPnlSol',0)
  armed = d.get('armed',0)
  proven = d.get('provenTokens',0)
  tokens = d.get('tokens',0)
  
  issues = []
  if trades == 0: issues.append('CRITICAL: Zero trades — pipeline may be blocked')
  if armed == 0 and tokens > 10: issues.append('WARNING: No armed tokens despite having registry')
  if losses > wins * 2 and trades > 3: issues.append('WARNING: Loss rate too high')
  
  print(f'  Trades: {trades} | W/L: {wins}/{losses} | PnL: {pnl:.4f} SOL')
  print(f'  Armed: {armed} | Proven: {proven} | Registry: {tokens}')
  if issues:
    for i in issues: print(f'  !! {i}')
  else:
    print('  No critical issues detected')
except: print('  Error generating summary')
" 2>/dev/null | tee -a "$LOG"

  log "════════════ SESSION $session REVIEW DONE ════════════"
  log ""
done

# ── FINAL REPORT ──
log ""
log "╔══════════════════════════════════════════════════════════════╗"
log "║  FINAL REPORT — ALL 10 SESSIONS COMPLETE                   ║"
log "╚══════════════════════════════════════════════════════════════╝"
snapshot "FINAL"
review_trades
wallet_compare
review_registry
log ""
log "Training complete. Log: $LOG"
