#!/usr/bin/env python3
"""
6-Hour Training Loop v2 — Deep 20-Minute Review Cycles
18 cycles. Each cycle is a forensic audit with domain sanity checks,
full spot-checking of important tokens, and cross-cycle escalation.
All raw data is dumped to JSONL for post-run verification.
"""

import json, time, os, sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen

BASE = os.environ.get("BOT_URL", "https://2wallets-algo-production.up.railway.app")
AUTH = os.environ.get("BOT_AUTH_TOKEN", "")
PUMP_API = "https://frontend-api-v3.pump.fun"
CYCLE_MINUTES = 20
TOTAL_CYCLES = 18
LOG_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, f"training_{datetime.now().strftime('%Y-%m-%dT%H-%M-%S')}.jsonl")

MC_BONDING_CURVE_MAX = 120_000

# Cross-cycle state for escalation
persistent_violations = []  # list of (cycle, count) for gate violations
persistent_missed = []      # list of (cycle, count) for missed runners


def api(path, base=BASE):
    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        if AUTH:
            headers["Authorization"] = f"Bearer {AUTH}"
        req = Request(f"{base}{path}", headers=headers)
        with urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"_error": str(e)}


def pump(mint):
    try:
        req = Request(f"{PUMP_API}/coins/{mint}", headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception:
        return None


def pump_list(sort, limit=50):
    try:
        req = Request(f"{PUMP_API}/coins?limit={limit}&sort={sort}&order=DESC",
                      headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        return []


def log_entry(entry):
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry, default=str) + "\n")
    return entry


def domain_sanity_check(token_data, pump_data):
    """Run domain-level sanity checks that go beyond drift comparison."""
    issues = []
    mc = token_data.get("mc", 0)
    ath = token_data.get("ath", 0)
    state = token_data.get("state", "?")

    if pump_data:
        real_sol = (pump_data.get("real_sol_reserves") or 0) / 1e9
        complete = pump_data.get("complete", False)
        raydium = pump_data.get("raydium_pool")

        if not complete and not raydium:
            if real_sol < 0.01 and mc > 10_000:
                issues.append(f"PHANTOM_MC: real_sol={real_sol:.4f} but MC=${mc:,} — fake data")
            if mc > MC_BONDING_CURVE_MAX:
                issues.append(f"MC_OVER_CURVE: ${mc:,} exceeds bonding curve max ${MC_BONDING_CURVE_MAX:,}")
            if ath > 1_000_000 and not complete:
                issues.append(f"ATH_IMPOSSIBLE: ${ath:,} ATH on non-migrated token")
        if complete or raydium:
            if state not in ("BLACKLISTED", "CLOSED"):
                issues.append(f"MIGRATED_STILL_TRACKED: token migrated but state={state}")
    else:
        if mc > MC_BONDING_CURVE_MAX:
            issues.append(f"MC_OVER_CURVE_NO_API: ${mc:,} exceeds bonding curve max, API unreachable")

    return issues


def run_cycle(cycle_num):
    ts = datetime.now(timezone.utc).isoformat()
    print(f"\n{'='*80}")
    print(f"  CYCLE {cycle_num}/{TOTAL_CYCLES} -- {ts}")
    print(f"{'='*80}\n")

    scorecard = {
        "cycle": cycle_num,
        "timestamp": ts,
        "sections_completed": [],
    }

    # --- Fetch all raw data ---
    raw_stats = api("/api/stats")
    raw_registry = api("/api/registry")
    raw_nursery = api("/api/nursery")
    raw_closed = api("/api/closed")
    raw_audit = api("/api/audit")

    log_entry({"cycle": cycle_num, "type": "RAW_STATS", "data": raw_stats})
    log_entry({"cycle": cycle_num, "type": "RAW_REGISTRY", "data": raw_registry})
    log_entry({"cycle": cycle_num, "type": "RAW_NURSERY", "data": raw_nursery})
    log_entry({"cycle": cycle_num, "type": "RAW_CLOSED", "data": raw_closed})
    log_entry({"cycle": cycle_num, "type": "RAW_AUDIT", "data": raw_audit})

    if isinstance(raw_registry, dict) and "_error" in raw_registry:
        print(f"  !! API ERROR: {raw_registry['_error']}")
        scorecard["error"] = raw_registry["_error"]
        log_entry({"cycle": cycle_num, "type": "SCORECARD", "data": scorecard})
        return scorecard

    registry = raw_registry if isinstance(raw_registry, list) else []
    closed = raw_closed if isinstance(raw_closed, list) else []
    audit = raw_audit if isinstance(raw_audit, dict) else {}

    # === SECTION A: Trade Forensics ===
    print("  [A] TRADE FORENSICS")
    trades_reviewed = 0
    trade_issues = []
    for t in closed:
        trades_reviewed += 1
        issues = []
        pnl = t.get("pnlPct", 0)
        hold = t.get("holdSec", 0)
        reason = t.get("reason", "?")
        if hold < 0.5:
            issues.append("HOLD_TOO_SHORT")
        if pnl < -10:
            issues.append(f"LARGE_LOSS_{pnl:.1f}%")
        if pnl > 50:
            issues.append(f"SUSPICIOUS_HIGH_PNL_{pnl:.1f}%")
        if reason == "NO_FOLLOWTHROUGH" and hold < 2:
            issues.append("INSTANT_NO_FOLLOW")
        entry_mc = t.get("entryMc", 0)
        exit_mc = t.get("exitMc", 0)
        if entry_mc > 0 and exit_mc > 0 and abs(entry_mc - exit_mc) < 1:
            issues.append("ZERO_MOVEMENT_TRADE")
        if issues:
            trade_issues.append({"symbol": t.get("symbol"), "mint": t.get("mint"),
                                 "pnl": pnl, "reason": reason, "hold": hold, "issues": issues})
    scorecard["SECTION_A_TRADES_REVIEWED"] = f"{trades_reviewed}/{len(closed)}"
    scorecard["SECTION_A_TRADE_ISSUES"] = trade_issues
    scorecard["sections_completed"].append("A")
    print(f"    Reviewed {trades_reviewed}/{len(closed)} trades | Issues: {len(trade_issues)}")

    # === SECTION B: Registry Integrity + Domain Sanity ===
    print("  [B] REGISTRY INTEGRITY + DOMAIN SANITY")

    # Identify important tokens that MUST be spot-checked
    important = [t for t in registry if t.get("state") in ("ARMED", "FLOORED")
                 or t.get("mc", 0) > 10_000]
    others = [t for t in registry if t not in important]

    # Spot-check ALL important tokens + sample of others
    import random
    sample_others = random.sample(others, min(10, len(others))) if others else []
    to_check = important + sample_others

    stale_tokens = []
    duplicates = {}
    spot_checks = []
    domain_issues = []
    tokens_checked = len(registry)

    for t in registry:
        # Stale detection using raw epoch
        last_ts = t.get("lastTickTs", 0)
        if last_ts > 0:
            stale_sec = int((time.time() * 1000 - last_ts) / 1000)
            if stale_sec > 120 and t.get("state") not in ("BLACKLISTED",):
                stale_tokens.append({"symbol": t["symbol"], "mint": t["mint"],
                                     "state": t["state"], "staleSec": stale_sec})

        sym = t.get("symbol", "?")
        if sym not in duplicates:
            duplicates[sym] = []
        duplicates[sym].append(t["mint"])

    dup_list = {s: ms for s, ms in duplicates.items() if len(ms) > 1}

    for t in to_check:
        real = pump(t["mint"])
        time.sleep(0.25)
        if real:
            real_mc = real.get("usd_market_cap", 0)
            real_ath = real.get("ath_market_cap", 0)
            our_mc = t.get("mc", 0)
            our_ath = t.get("ath", 0)
            mc_drift = abs(our_mc - real_mc) / max(real_mc, 1) * 100
            ath_drift = abs(our_ath - real_ath) / max(real_ath, 1) * 100

            # Domain sanity
            d_issues = domain_sanity_check(t, real)
            if d_issues:
                domain_issues.extend([{"mint": t["mint"], "symbol": t["symbol"], "issue": i} for i in d_issues])

            spot_checks.append({
                "mint": t["mint"], "symbol": t["symbol"],
                "state": t.get("state"),
                "ourMc": our_mc, "realMc": round(real_mc),
                "mcDriftPct": round(mc_drift, 1),
                "ourAth": our_ath, "realAth": round(real_ath),
                "athDriftPct": round(ath_drift, 1),
                "migrated": real.get("complete", False) or real.get("raydium_pool") is not None,
                "realSolReserves": round((real.get("real_sol_reserves") or 0) / 1e9, 4),
                "domainIssues": d_issues,
            })
        else:
            # API unreachable — still do domain check with what we have
            d_issues = domain_sanity_check(t, None)
            if d_issues:
                domain_issues.extend([{"mint": t["mint"], "symbol": t["symbol"], "issue": i} for i in d_issues])

    scorecard["SECTION_B_TOKENS_CHECKED"] = f"{tokens_checked}/{len(registry)}"
    scorecard["SECTION_B_STALE_COUNT"] = len(stale_tokens)
    scorecard["SECTION_B_STALE_TOKENS"] = stale_tokens[:30]
    scorecard["SECTION_B_DUPLICATES"] = dup_list
    scorecard["SECTION_B_SPOT_CHECKS"] = len(spot_checks)
    scorecard["SECTION_B_IMPORTANT_CHECKED"] = len(important)
    scorecard["SECTION_B_DOMAIN_ISSUES"] = domain_issues
    scorecard["sections_completed"].append("B")
    drift_warn = [s for s in spot_checks if s["mcDriftPct"] > 20]
    phantom_warn = [d for d in domain_issues if "PHANTOM" in d.get("issue", "")]
    print(f"    Checked {tokens_checked}/{len(registry)} | Important: {len(important)} | "
          f"Spot-checks: {len(spot_checks)} | Stale>2m: {len(stale_tokens)} | "
          f"Drift warnings: {len(drift_warn)} | Domain issues: {len(domain_issues)} | "
          f"Phantoms: {len(phantom_warn)}")

    # === SECTION C: Gate Compliance (zero error policy) ===
    print("  [C] GATE COMPLIANCE (zero error policy)")
    gate_violations = []
    armed_audit = audit.get("armedAudit", [])
    for a in armed_audit:
        if not a.get("allGatesPass"):
            gate_violations.append({
                "type": "ARMED_GATE_FAIL",
                "symbol": a["symbol"], "mint": a["mint"],
                "failedGate": a.get("failedGate"),
                "reason": a.get("failReason"),
            })

    blocked = audit.get("blockedAudit", [])
    # Tokens stuck in WATCHING for too long
    watching_stuck = [t for t in registry
                      if t.get("state") == "WATCHING"
                      and t.get("lastTickTs", 0) > 0
                      and (time.time() * 1000 - t["lastTickTs"]) > 30 * 60 * 1000]

    trade_gate_checks = audit.get("tradeGateCheck", [])
    scorecard["SECTION_C_GATES_VERIFIED"] = f"{len(trade_gate_checks)}/{len(closed)}"
    scorecard["SECTION_C_GATE_VIOLATIONS"] = gate_violations if gate_violations else "NONE"
    scorecard["SECTION_C_ARMED_AUDIT"] = armed_audit
    scorecard["SECTION_C_WATCHING_STUCK"] = len(watching_stuck)
    scorecard["sections_completed"].append("C")

    # Track for cross-cycle escalation
    persistent_violations.append((cycle_num, len(gate_violations)))

    print(f"    Gate violations: {len(gate_violations)} | Trades gate-checked: "
          f"{len(trade_gate_checks)} | Stuck in WATCHING: {len(watching_stuck)}")

    # === SECTION D: Bonded Coins / Market Coverage ===
    print("  [D] MARKET-WIDE COVERAGE")
    our_mints = set(t["mint"] for t in registry)

    top_mc = pump_list("market_cap", 50)
    time.sleep(0.4)
    top_trade = pump_list("last_trade_timestamp", 50)
    time.sleep(0.4)
    top_live = pump_list("currently_live", 50)

    log_entry({"cycle": cycle_num, "type": "RAW_MARKET_TOP_MC", "data": top_mc})
    log_entry({"cycle": cycle_num, "type": "RAW_MARKET_TOP_TRADE", "data": top_trade})
    log_entry({"cycle": cycle_num, "type": "RAW_MARKET_TOP_LIVE", "data": top_live})

    all_market = {}
    for lst in [top_mc, top_trade, top_live]:
        if not isinstance(lst, list):
            continue
        for c in lst:
            mint = c.get("mint")
            if mint and mint not in all_market:
                all_market[mint] = c

    bonded_checked = 0
    missed_runners = []
    runners_we_caught = 0
    for mint, c in all_market.items():
        ath = c.get("ath_market_cap", 0)
        complete = c.get("complete", False)
        raydium = c.get("raydium_pool")
        real_sol = (c.get("real_sol_reserves") or 0) / 1e9

        # Skip phantom MC tokens in market data too
        if not complete and not raydium and real_sol < 0.01 and ath > 100_000:
            continue

        if ath < 20_000:
            continue
        bonded_checked += 1
        if mint in our_mints:
            runners_we_caught += 1
        else:
            reason = "NOT_DISCOVERED"
            if complete or raydium:
                reason = "MIGRATED_BEFORE_DISCOVERY"
            missed_runners.append({
                "mint": mint, "symbol": c.get("symbol", "?"),
                "ath": round(ath), "mc": round(c.get("usd_market_cap", 0)),
                "reason_missed": reason,
                "complete": complete,
            })

    persistent_missed.append((cycle_num, len(missed_runners)))

    scorecard["SECTION_D_BONDED_CHECKED"] = bonded_checked
    scorecard["SECTION_D_MISSED_RUNNERS"] = missed_runners[:25]
    scorecard["SECTION_D_RUNNERS_CAUGHT"] = runners_we_caught
    scorecard["SECTION_D_COVERAGE_PCT"] = round(runners_we_caught / max(1, bonded_checked) * 100, 1)
    scorecard["sections_completed"].append("D")
    print(f"    Runners checked: {bonded_checked} | Caught: {runners_we_caught} | "
          f"Missed: {len(missed_runners)} | Coverage: {scorecard['SECTION_D_COVERAGE_PCT']}%")

    # === SECTION E: Profitability ===
    print("  [E] PROFITABILITY")
    stats = raw_stats if isinstance(raw_stats, dict) else {}
    net_pnl = stats.get("netPnlSol", 0)
    trades_total = stats.get("trades", 0)
    wins = stats.get("wins", 0)
    losses = stats.get("losses", 0)
    win_rate = round(wins / max(1, trades_total) * 100, 1) if trades_total > 0 else 0

    loss_reasons = {}
    win_reasons = {}
    for t in closed:
        r = t.get("reason", "?")
        if t.get("pnlPct", 0) >= 0:
            win_reasons[r] = win_reasons.get(r, 0) + 1
        else:
            loss_reasons[r] = loss_reasons.get(r, 0) + 1

    avg_pnl = sum(t.get("pnlPct", 0) for t in closed) / max(1, len(closed)) if closed else 0
    avg_hold = sum(t.get("holdSec", 0) for t in closed) / max(1, len(closed)) if closed else 0

    scorecard["SECTION_E_NET_PNL"] = round(net_pnl, 6)
    scorecard["SECTION_E_WIN_RATE"] = win_rate
    scorecard["SECTION_E_TRADES"] = trades_total
    scorecard["SECTION_E_AVG_PNL_PCT"] = round(avg_pnl, 2)
    scorecard["SECTION_E_AVG_HOLD_SEC"] = round(avg_hold, 1)
    scorecard["SECTION_E_LOSS_REASONS"] = loss_reasons
    scorecard["SECTION_E_WIN_REASONS"] = win_reasons
    scorecard["sections_completed"].append("E")
    print(f"    PnL: {net_pnl:+.6f} SOL | Trades: {trades_total} | WR: {win_rate}% | "
          f"Avg PnL: {avg_pnl:+.2f}% | Avg hold: {avg_hold:.1f}s")

    # === SECTION F: Issue Log ===
    print("  [F] ISSUE LOG")
    issues = []

    # Critical: gate violations
    for gv in gate_violations:
        issues.append({"severity": "CRITICAL",
                        "issue": f"GATE_VIOLATION: {gv['symbol']} armed but {gv['failedGate']} fails: {gv['reason']}"})

    # Critical: domain sanity
    for di in domain_issues:
        issues.append({"severity": "CRITICAL", "issue": f"DOMAIN: {di['symbol']} — {di['issue']}"})

    # High: data drift
    for dw in drift_warn:
        issues.append({"severity": "HIGH",
                        "issue": f"DATA_DRIFT: {dw['symbol']} MC drift {dw['mcDriftPct']}%"})

    # High: missed runners (only non-migrated)
    non_migrated_missed = [mr for mr in missed_runners if mr["reason_missed"] != "MIGRATED_BEFORE_DISCOVERY"]
    for mr in non_migrated_missed[:5]:
        issues.append({"severity": "HIGH",
                        "issue": f"MISSED_RUNNER: {mr['symbol']} ATH ${mr['ath']:,} — {mr['reason_missed']}"})

    # High: staleness
    if len(stale_tokens) > len(registry) * 0.3 and len(registry) > 5:
        issues.append({"severity": "HIGH",
                        "issue": f"STALENESS: {len(stale_tokens)}/{len(registry)} tokens stale >2min"})

    # High: unprofitable
    if net_pnl < -0.1 and trades_total >= 5:
        issues.append({"severity": "HIGH",
                        "issue": f"UNPROFITABLE: {net_pnl:+.4f} SOL after {trades_total} trades"})

    # Medium: watching stuck
    if watching_stuck:
        issues.append({"severity": "MEDIUM",
                        "issue": f"WATCHING_STUCK: {len(watching_stuck)} tokens stuck in WATCHING >30min"})

    # Medium: pending buys/sells
    pending_b = audit.get("pendingBuys", 0)
    pending_s = audit.get("pendingSells", 0)
    if pending_b > 0 or pending_s > 0:
        issues.append({"severity": "MEDIUM",
                        "issue": f"PENDING_ORDERS: {pending_b} buys, {pending_s} sells queued"})

    scorecard["SECTION_F_ISSUES"] = issues if issues else "NONE"
    scorecard["sections_completed"].append("F")
    for iss in issues[:15]:
        print(f"    [{iss['severity']:8}] {iss['issue']}")
    if not issues:
        print("    No issues found")

    # === SECTION G: Self-Audit + Cross-Cycle Escalation ===
    print("  [G] SELF-AUDIT + CROSS-CYCLE ESCALATION")
    passed = True
    fail_reasons = []

    if len(spot_checks) < len(important):
        passed = False
        fail_reasons.append(f"IMPORTANT_NOT_FULLY_CHECKED={len(spot_checks)}/{len(important)}")
    if len(scorecard["sections_completed"]) < 6:
        passed = False
        fail_reasons.append(f"SECTIONS_INCOMPLETE={scorecard['sections_completed']}")

    # Cross-cycle escalation: gate violations persistent for 3+ cycles
    escalations = []
    if len(persistent_violations) >= 3:
        recent = persistent_violations[-3:]
        if all(count > 0 for _, count in recent):
            escalations.append(f"CRITICAL_UNRESOLVED: Gate violations in {len(recent)} consecutive cycles: {recent}")

    # Cross-cycle escalation: PnL declining 3 cycles
    # (We'd need to track PnL across cycles — use the scorecard we'll log)

    # Cross-cycle escalation: missed runners increasing
    if len(persistent_missed) >= 3:
        recent_m = [count for _, count in persistent_missed[-3:]]
        if all(m > prev for m, prev in zip(recent_m[1:], recent_m)):
            escalations.append(f"COVERAGE_DEGRADING: Missed runners increasing: {recent_m}")

    scorecard["SECTIONS_COMPLETED"] = scorecard["sections_completed"]
    scorecard["SELF_AUDIT_PASSED"] = passed
    scorecard["SELF_AUDIT_FAIL_REASONS"] = fail_reasons if fail_reasons else "NONE"
    scorecard["ESCALATIONS"] = escalations if escalations else "NONE"
    print(f"    Passed: {passed}" + (f" -- FAILURES: {fail_reasons}" if fail_reasons else ""))
    for esc in escalations:
        print(f"    ** ESCALATION: {esc}")

    # --- Log the full scorecard ---
    log_entry({"cycle": cycle_num, "type": "SCORECARD", "data": scorecard})

    # --- Print summary ---
    print(f"\n  SUMMARY: PnL={net_pnl:+.6f} SOL | Trades={trades_total} | WR={win_rate}% | "
          f"Registry={len(registry)} | Armed={stats.get('armed',0)} | Issues={len(issues)}")
    print(f"  Coverage: {runners_we_caught}/{bonded_checked} runners ({scorecard['SECTION_D_COVERAGE_PCT']}%) | "
          f"Stale: {len(stale_tokens)} | Gate violations: {len(gate_violations)} | "
          f"Domain issues: {len(domain_issues)}")
    print(f"  Scorecard: {'PASS' if passed else 'FAIL'}" +
          (f" | ESCALATIONS: {len(escalations)}" if escalations else ""))

    return scorecard


def run_final_summary(all_scorecards):
    print(f"\n{'#'*80}")
    print(f"  FINAL SUMMARY -- {len(all_scorecards)} CYCLES COMPLETED")
    print(f"{'#'*80}\n")

    passed = sum(1 for s in all_scorecards if s.get("SELF_AUDIT_PASSED"))
    failed = len(all_scorecards) - passed
    print(f"  Cycles passed: {passed}/{len(all_scorecards)} | Failed: {failed}")

    all_issues = []
    for s in all_scorecards:
        iss = s.get("SECTION_F_ISSUES", [])
        if isinstance(iss, list):
            all_issues.extend(iss)

    issue_counts = {}
    for i in all_issues:
        key = i.get("issue", "?")[:60]
        issue_counts[key] = issue_counts.get(key, 0) + 1

    chronic = {k: v for k, v in issue_counts.items() if v >= 3}
    if chronic:
        print(f"\n  CHRONIC ISSUES (appeared 3+ cycles):")
        for k, v in sorted(chronic.items(), key=lambda x: -x[1]):
            print(f"    [{v}x] {k}")

    pnl_values = [s.get("SECTION_E_NET_PNL", 0) for s in all_scorecards
                  if s.get("SECTION_E_NET_PNL") is not None]
    if pnl_values:
        print(f"\n  PnL trend: {' -> '.join(f'{p:+.4f}' for p in pnl_values)}")

    # All escalations
    all_escalations = []
    for s in all_scorecards:
        esc = s.get("ESCALATIONS", [])
        if isinstance(esc, list):
            all_escalations.extend(esc)
    if all_escalations:
        print(f"\n  ESCALATIONS FIRED: {len(all_escalations)}")
        for e in all_escalations:
            print(f"    ** {e}")

    # Domain issues across all cycles
    all_domain = []
    for s in all_scorecards:
        di = s.get("SECTION_B_DOMAIN_ISSUES", [])
        if isinstance(di, list):
            all_domain.extend(di)
    if all_domain:
        unique_domain = {}
        for d in all_domain:
            k = d.get("issue", "?")
            if k not in unique_domain:
                unique_domain[k] = d
        print(f"\n  UNIQUE DOMAIN ISSUES: {len(unique_domain)}")
        for d in list(unique_domain.values())[:10]:
            print(f"    {d.get('symbol','?')}: {d.get('issue','?')}")

    last = all_scorecards[-1] if all_scorecards else {}
    print(f"\n  Final: PnL={last.get('SECTION_E_NET_PNL', 0):+.6f} SOL | "
          f"Trades={last.get('SECTION_E_TRADES', 0)} | WR={last.get('SECTION_E_WIN_RATE', 0)}%")
    print(f"  Coverage: {last.get('SECTION_D_COVERAGE_PCT', 0)}%")

    log_entry({"type": "FINAL_SUMMARY", "cycles": len(all_scorecards),
               "passed": passed, "failed": failed,
               "chronic_issues": chronic, "pnl_trend": pnl_values,
               "escalations_fired": len(all_escalations),
               "domain_issues_total": len(all_domain)})

    print(f"\n  Full log: {LOG_FILE}")
    print(f"{'#'*80}\n")


if __name__ == "__main__":
    print(f"{'='*60}")
    print(f"  6-HOUR TRAINING LOOP v2 -- {TOTAL_CYCLES} cycles x {CYCLE_MINUTES}min")
    print(f"  Bot: {BASE}")
    print(f"  Log: {LOG_FILE}")
    print(f"  Auth: {'set' if AUTH else 'none'}")
    print(f"{'='*60}\n")

    all_scorecards = []
    for cycle in range(1, TOTAL_CYCLES + 1):
        try:
            sc = run_cycle(cycle)
            all_scorecards.append(sc)
        except Exception as e:
            print(f"\n  !! CYCLE {cycle} ERROR: {e}")
            import traceback
            traceback.print_exc()
            all_scorecards.append({"cycle": cycle, "error": str(e)})

        if cycle < TOTAL_CYCLES:
            print(f"\n  Sleeping {CYCLE_MINUTES} minutes until cycle {cycle+1}...")
            time.sleep(CYCLE_MINUTES * 60)

    run_final_summary(all_scorecards)
