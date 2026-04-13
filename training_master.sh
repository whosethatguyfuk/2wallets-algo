#!/bin/bash
# 6-HOUR AUTONOMOUS TRAINING LOOP
# Runs 6 x 1hr paper trading sessions with comprehensive hourly reviews
# Each session: monitor → review → iterate → restart

set -euo pipefail

BASE_URL="${BOT_URL:-https://2wallets-algo-production.up.railway.app}"
AUTH="${BOT_AUTH_TOKEN:-}"
DATA_DIR="$(dirname "$0")/data"
mkdir -p "$DATA_DIR"

MASTER_LOG="$DATA_DIR/training_master_$(date +%Y-%m-%dT%H-%M-%S).log"
SESSION_DURATION_SEC=3600  # 1 hour per session
MONITOR_INTERVAL_SEC=300   # check every 5 min during session

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$MASTER_LOG"
}

api() {
  local path="$1"
  curl -sf --max-time 15 \
    -H "User-Agent: Mozilla/5.0" \
    ${AUTH:+-H "Authorization: Bearer $AUTH"} \
    "${BASE_URL}${path}" 2>/dev/null || echo '{"_error":"failed"}'
}

snapshot() {
  local label="$1"
  log "[$label] Taking state snapshot..."
  local stats=$(api "/api/stats")
  echo "$stats" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"  Version: {d.get('version','?')}\")
print(f\"  Registry: {d.get('registrySize','?')} | Nursery: {d.get('nurserySize','?')} | Born: {d.get('bornCount','?')}\")
print(f\"  Armed: {d.get('armedCount','?')} | Open: {d.get('openCount','?')} | Closed: {d.get('closedCount','?')}\")
print(f\"  PnL: {d.get('pnl','?')} SOL | Trades: {d.get('trades','?')} | WR: {d.get('winRate','?')}%\")
print(f\"  States: {d.get('states',{})}\")
" 2>/dev/null | tee -a "$MASTER_LOG"
}

monitor_session() {
  local session_num="$1"
  local end_time="$2"
  local check_count=0

  while [ "$(date +%s)" -lt "$end_time" ]; do
    check_count=$((check_count + 1))
    local remaining=$(( (end_time - $(date +%s)) / 60 ))
    log "Session $session_num | Check #$check_count | ${remaining}min remaining"
    
    snapshot "S${session_num}-CHECK${check_count}"
    
    # Quick audit check
    local audit=$(api "/api/audit")
    echo "$audit" | python3 -c "
import json,sys
d=json.load(sys.stdin)
blocked = d.get('blockedAudit',[])
armed = d.get('armedAudit',[])
violations = [a for a in armed if not a.get('allGatesPass')]
print(f\"  Blocked→Armed pipeline: {len(blocked)} tokens blocked | {len(armed)} armed\")
if violations:
    for v in violations:
        print(f\"  !! GATE VIOLATION: {v.get('symbol')} - {v.get('failedGate')}\")
floored_ready = [b for b in blocked if b.get('state')=='FLOORED' and b.get('floorGatePass') and b.get('mc',0) > 4000]
if floored_ready:
    for f in floored_ready:
        print(f\"  FLOORED & READY: {f['symbol']} MC=\${f['mc']} floor=\${f['floor']} aboveFloor={f['aboveFloorPct']}%\")
" 2>/dev/null | tee -a "$MASTER_LOG"
    
    sleep $MONITOR_INTERVAL_SEC
  done
}

#####################################################################
log "=== 6-HOUR TRAINING MASTER STARTED ==="
log "Bot: $BASE_URL"
snapshot "START"

TOTAL_REPORTS=""

for session in 1 2 3 4 5 6; do
  log ""
  log "################################################################"
  log "  SESSION $session / 6 — STARTING"
  log "################################################################"
  
  session_start=$(date +%s)
  session_end=$((session_start + SESSION_DURATION_SEC))
  
  # Monitor the session
  monitor_session "$session" "$session_end"
  
  # Run comprehensive hourly review
  log ""
  log "Session $session COMPLETE — Running comprehensive review..."
  
  SESSION_NUM="$session" python3 "$(dirname "$0")/hourly_review.py" 2>&1 | tee -a "$MASTER_LOG"
  
  log "Session $session review done."
  log ""
done

# Final summary
log ""
log "################################################################"
log "  FINAL SESSION 7 — 6-HOUR SUMMARY"  
log "################################################################"

snapshot "FINAL"

log ""
log "6-HOUR TRAINING COMPLETE. Review master log: $MASTER_LOG"
log "Individual session logs in: $DATA_DIR/"
