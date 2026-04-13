#!/usr/bin/env python3
"""
Hourly Session Review — Bonded Coin Scan + Comprehensive Report
Run after each 1-hour paper trading session.
Scans ALL tokens that bonded in the last hour, cross-references with our registry,
and identifies missed opportunities with root-cause analysis.
"""

import json, time, os, sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen

BASE = os.environ.get("BOT_URL", "https://2wallets-algo-production.up.railway.app")
AUTH = os.environ.get("BOT_AUTH_TOKEN", "")
PUMP_API = "https://frontend-api-v3.pump.fun"
LOG_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(LOG_DIR, exist_ok=True)

MC_BONDING_CURVE_MAX = 120_000
SESSION_NUM = int(os.environ.get("SESSION_NUM", "1"))

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

def log_entry(entry, logfile):
    with open(logfile, "a") as f:
        f.write(json.dumps(entry, default=str) + "\n")

def run_review():
    ts = datetime.now(timezone.utc).isoformat()
    logfile = os.path.join(LOG_DIR, f"session_{SESSION_NUM}_{datetime.now().strftime('%Y-%m-%dT%H-%M')}.jsonl")

    print(f"\n{'='*80}")
    print(f"  SESSION {SESSION_NUM} HOURLY REVIEW — {ts}")
    print(f"  Log: {logfile}")
    print(f"{'='*80}\n")

    report = {"session": SESSION_NUM, "timestamp": ts}

    # ── 1. Fetch our bot state ────────────────────────────────
    stats = api("/api/stats")
    registry_raw = api("/api/registry")
    closed_raw = api("/api/closed")
    audit_raw = api("/api/audit")
    nursery_raw = api("/api/nursery")

    log_entry({"type": "RAW_STATS", "data": stats}, logfile)
    log_entry({"type": "RAW_REGISTRY", "data": registry_raw}, logfile)
    log_entry({"type": "RAW_CLOSED", "data": closed_raw}, logfile)
    log_entry({"type": "RAW_AUDIT", "data": audit_raw}, logfile)

    registry = registry_raw if isinstance(registry_raw, list) else []
    closed = closed_raw if isinstance(closed_raw, list) else []
    audit = audit_raw if isinstance(audit_raw, dict) else {}
    nursery = nursery_raw if isinstance(nursery_raw, list) else []
    our_mints = set(t["mint"] for t in registry)
    our_nursery_mints = set(n["mint"] for n in nursery)

    report["bot"] = {
        "version": stats.get("version"),
        "registry": len(registry),
        "nursery": len(nursery),
        "nurseryTotal": stats.get("nurseryTotal", 0),
        "trades": stats.get("trades", 0),
        "wins": stats.get("wins", 0),
        "losses": stats.get("losses", 0),
        "netPnlSol": stats.get("netPnlSol", 0),
        "armed": stats.get("armed", 0),
        "byState": stats.get("byState", {}),
    }

    # ── 2. Scan ALL bonded coins from pump.fun ────────────────
    # "Bonded" = tokens that reached migration in the last hour-ish
    # We also scan top MC, top traded, and currently live to catch runners
    print("  [1] SCANNING PUMP.FUN FOR BONDED / HIGH-PERFORMING COINS...")

    all_market = {}
    for sort_key in ["market_cap", "last_trade_timestamp", "currently_live"]:
        coins = pump_list(sort_key, 50)
        time.sleep(0.4)
        if isinstance(coins, list):
            for c in coins:
                mint = c.get("mint")
                if mint and mint not in all_market:
                    all_market[mint] = c

    # Filter to RECENT coins with real activity
    significant_coins = {}
    bonded_coins = {}
    now_ms = time.time() * 1000
    for mint, c in all_market.items():
        ath = c.get("ath_market_cap", 0)
        mc = c.get("usd_market_cap", 0)
        complete = c.get("complete", False)
        raydium = c.get("raydium_pool")
        real_sol = (c.get("real_sol_reserves") or 0) / 1e9
        created = c.get("created_timestamp", 0)

        # Skip phantom MC
        if not complete and not raydium and real_sol < 0.01 and mc > 10_000:
            continue

        # Only count tokens created in last 3 hours as relevant
        age_min = (now_ms - created) / 60_000 if created > 0 else 999999
        is_recent = age_min < 180

        if complete or raydium:
            bonded_coins[mint] = c

        if ath >= 15_000 and is_recent:
            significant_coins[mint] = c

    print(f"    Found {len(all_market)} total coins | {len(bonded_coins)} bonded | {len(significant_coins)} significant (ATH>$15K)")

    # ── 3. Cross-reference: which did we catch? ───────────────
    print("\n  [2] CROSS-REFERENCING WITH OUR REGISTRY...")

    caught = []
    missed = []
    missed_bonded = []

    for mint, c in significant_coins.items():
        sym = c.get("symbol", "?")
        ath = c.get("ath_market_cap", 0)
        mc = c.get("usd_market_cap", 0)
        complete = c.get("complete", False)
        raydium = c.get("raydium_pool")
        real_sol = (c.get("real_sol_reserves") or 0) / 1e9

        in_registry = mint in our_mints
        in_nursery = mint in our_nursery_mints
        traded = any(t["mint"] == mint for t in closed)

        entry = {
            "mint": mint, "symbol": sym,
            "ath": round(ath), "mc": round(mc),
            "bonded": complete or raydium is not None,
            "realSol": round(real_sol, 2),
            "inRegistry": in_registry,
            "inNursery": in_nursery,
            "traded": traded,
        }

        if in_registry:
            reg_token = next((t for t in registry if t["mint"] == mint), None)
            if reg_token:
                entry["ourState"] = reg_token.get("state")
                entry["ourMc"] = reg_token.get("mc")
                entry["ourAth"] = reg_token.get("ath")
                entry["buyers"] = reg_token.get("buyers", 0)
                entry["histLoaded"] = reg_token.get("histLoaded")
                entry["liveTrades"] = reg_token.get("liveTrades", 0)
            caught.append(entry)
        else:
            # Root-cause analysis: WHY did we miss it?
            reasons = []

            if complete or raydium:
                # Check creation time
                created = c.get("created_timestamp", 0)
                if created > 0:
                    age_min = (time.time() * 1000 - created) / 60_000
                    if age_min > 120:
                        reasons.append(f"CREATED_{age_min:.0f}min_AGO (before our session)")
                    else:
                        reasons.append("BONDED_DURING_SESSION")
                else:
                    reasons.append("MIGRATED")

            if in_nursery:
                reasons.append("IN_NURSERY_NOT_PROMOTED")
            elif not in_registry and not in_nursery:
                reasons.append("NEVER_DISCOVERED")

            # Check if it would have passed our gates
            if ath < 15_000:
                reasons.append("ATH_TOO_LOW_FOR_ROUND2")

            if not reasons:
                reasons.append("UNKNOWN")

            entry["missReasons"] = reasons
            missed.append(entry)

            if complete or raydium:
                missed_bonded.append(entry)

    # Sort missed by ATH descending
    missed.sort(key=lambda x: -x["ath"])
    caught.sort(key=lambda x: -x["ath"])

    print(f"    Caught: {len(caught)} | Missed: {len(missed)} | Missed bonded: {len(missed_bonded)}")

    # ── 4. Deep-dive into our trades ──────────────────────────
    print("\n  [3] TRADE ANALYSIS...")

    trade_analysis = []
    for t in closed:
        pnl = t.get("pnlPct", 0)
        hold = t.get("holdSec", 0)
        reason = t.get("reason", "?")
        entry_mc = t.get("entryMc", 0)
        exit_mc = t.get("exitMc", 0)

        issues = []
        if hold < 1:
            issues.append("INSTANT_EXIT")
        if pnl < -5:
            issues.append(f"BIG_LOSS_{pnl:.1f}%")
        if pnl > 30:
            issues.append(f"VERIFY_HIGH_PNL_{pnl:.1f}%")
        if reason == "NO_FOLLOWTHROUGH":
            issues.append("NO_FOLLOW_THROUGH")

        # Check against pump.fun reality
        real = pump(t["mint"])
        time.sleep(0.2)
        real_ath = 0
        if real:
            real_ath = real.get("ath_market_cap", 0)
            if real_ath > exit_mc * 1.5 and pnl < 0:
                issues.append(f"EXITED_EARLY_ATH_WAS_${round(real_ath)}")

        trade_analysis.append({
            "symbol": t.get("symbol"), "mint": t.get("mint"),
            "entryMc": entry_mc, "exitMc": exit_mc,
            "pnlPct": round(pnl, 2), "holdSec": round(hold, 1),
            "reason": reason, "realAth": round(real_ath),
            "issues": issues,
        })

    # ── 5. Gate compliance check ──────────────────────────────
    print("\n  [4] GATE COMPLIANCE...")

    gate_violations = []
    armed_audit = audit.get("armedAudit", [])
    for a in armed_audit:
        if not a.get("allGatesPass"):
            gate_violations.append({
                "symbol": a["symbol"], "mint": a["mint"],
                "failedGate": a.get("failedGate"),
                "reason": a.get("failReason"),
            })

    # Check for tokens stuck in states
    stuck_watching = [t for t in registry if t.get("state") == "WATCHING"
                      and t.get("lastTickTs", 0) > 0
                      and (time.time() * 1000 - t["lastTickTs"]) > 10 * 60 * 1000]

    stale_tokens = [t for t in registry
                    if t.get("lastTickTs", 0) > 0
                    and (time.time() * 1000 - t["lastTickTs"]) > 120 * 1000
                    and t.get("state") not in ("BLACKLISTED",)]

    # ── 6. Error accounting ───────────────────────────────────
    print("\n  [5] ERROR ACCOUNTING (our errors + data provider errors)...")

    # Spot-check 10 registry tokens against pump.fun for data accuracy
    import random
    sample = random.sample(registry, min(10, len(registry))) if registry else []
    data_errors = []
    for t in sample:
        real = pump(t["mint"])
        time.sleep(0.2)
        if real:
            real_mc = real.get("usd_market_cap", 0)
            our_mc = t.get("mc", 0)
            real_sol = (real.get("real_sol_reserves") or 0) / 1e9
            complete = real.get("complete", False)

            # Phantom check
            if not complete and real_sol < 0.01 and our_mc > 5_000:
                data_errors.append({
                    "type": "PHANTOM_MC_IN_REGISTRY",
                    "symbol": t["symbol"], "mint": t["mint"],
                    "ourMc": our_mc, "realSol": real_sol,
                    "source": "pump.fun API returned fake MC, our filter should have caught this"
                })

            # Drift check
            if real_mc > 0:
                drift = abs(our_mc - real_mc) / real_mc * 100
                if drift > 25:
                    data_errors.append({
                        "type": "MC_DRIFT",
                        "symbol": t["symbol"], "mint": t["mint"],
                        "ourMc": our_mc, "realMc": round(real_mc), "driftPct": round(drift, 1),
                        "source": "PumpPortal may have stopped sending ticks, or our refresh failed"
                    })

            # Migrated but still tracked
            if complete and t.get("state") not in ("BLACKLISTED", "CLOSED"):
                data_errors.append({
                    "type": "MIGRATED_STILL_TRACKED",
                    "symbol": t["symbol"], "mint": t["mint"],
                    "state": t.get("state"),
                    "source": "Our migration detection missed this, or pump.fun API refresh didn't run"
                })

    # ── 7. Assemble report ────────────────────────────────────
    print(f"\n  [6] ASSEMBLING REPORT...")

    report["trades"] = {
        "total": len(closed),
        "analysis": trade_analysis,
        "pnlSol": stats.get("netPnlSol", 0),
        "winRate": stats.get("winRate", 0),
    }
    report["coverage"] = {
        "significantCoins": len(significant_coins),
        "bondedCoins": len(bonded_coins),
        "caught": len(caught),
        "missed": len(missed),
        "missedBonded": len(missed_bonded),
        "coveragePct": round(len(caught) / max(1, len(significant_coins)) * 100, 1),
        "caughtDetails": caught[:20],
        "missedDetails": missed[:20],
        "missedBondedDetails": missed_bonded[:10],
    }
    report["gateCompliance"] = {
        "violations": gate_violations,
        "stuckWatching": len(stuck_watching),
        "staleTokens": len(stale_tokens),
    }
    report["errorAccounting"] = {
        "dataErrors": data_errors,
        "spotChecked": len(sample),
        "possiblePpErrors": "PumpPortal can misclassify buy/sell (txType), report stale solAmount, or silently drop subscriptions",
        "possibleOurErrors": "MC direction override could flip sells to buys, nursery promotion could miss high-potential tokens, floor detection with thin data",
        "possibleApiErrors": "Pump.fun API can return phantom MC (real_sol=0 but high usd_market_cap), stale ath_market_cap, or incorrect complete status",
    }

    # ── 8. Recommendations ────────────────────────────────────
    recommendations = []

    if len(missed) > len(caught) * 2 and len(significant_coins) > 5:
        recommendations.append("DISCOVERY_TOO_NARROW: We're missing more runners than we catch. Consider lowering nursery promotion thresholds or seeding more aggressively.")

    if gate_violations:
        recommendations.append(f"GATE_VIOLATIONS: {len(gate_violations)} tokens armed with failing gates. Fix the state machine before next session.")

    if len(stale_tokens) > len(registry) * 0.3:
        recommendations.append(f"STALENESS: {len(stale_tokens)}/{len(registry)} tokens stale. PP re-subscribe or API refresh may be failing.")

    no_trade_floored = [t for t in registry if t.get("state") == "FLOORED" and t.get("mc", 0) > 6000]
    if no_trade_floored and stats.get("trades", 0) == 0:
        recommendations.append(f"FLOORED_NO_TRADES: {len(no_trade_floored)} tokens floored with decent MC but 0 trades. Check if arm zone or catalyst is too strict.")

    if data_errors:
        recommendations.append(f"DATA_ERRORS: {len(data_errors)} data integrity issues found. See errorAccounting for details.")

    for mr in missed_bonded[:3]:
        reasons = mr.get("missReasons", [])
        if "BONDED_DURING_SESSION" in reasons:
            recommendations.append(f"MISSED_BONDED: {mr['symbol']} bonded during session (ATH ${mr['ath']:,}) but we didn't catch it. Root cause: {reasons}")

    report["recommendations"] = recommendations

    log_entry({"type": "SESSION_REPORT", "data": report}, logfile)

    # ── 9. Print human-readable report ────────────────────────
    print(f"\n{'='*80}")
    print(f"  SESSION {SESSION_NUM} REPORT")
    print(f"{'='*80}")

    print(f"\n  BOT STATUS")
    print(f"    Version: {stats.get('version')} | Registry: {len(registry)} | Nursery: {len(nursery)} | Born total: {stats.get('nurseryTotal',0)}")
    print(f"    PnL: {stats.get('netPnlSol',0):+.6f} SOL | Trades: {stats.get('trades',0)} | WR: {stats.get('winRate',0)}%")
    print(f"    States: {stats.get('byState',{})}")

    print(f"\n  TRADE ANALYSIS ({len(closed)} trades)")
    if trade_analysis:
        for ta in trade_analysis:
            iss = " | ".join(ta["issues"]) if ta["issues"] else "clean"
            print(f"    {ta['symbol']:12} entry=${ta['entryMc']:>6} exit=${ta['exitMc']:>6} PnL={ta['pnlPct']:+.1f}% hold={ta['holdSec']:.0f}s reason={ta['reason']} [{iss}]")
    else:
        print(f"    No trades this session")

    print(f"\n  MARKET COVERAGE")
    print(f"    Significant coins (ATH>$15K): {len(significant_coins)}")
    print(f"    Bonded coins: {len(bonded_coins)}")
    print(f"    WE CAUGHT: {len(caught)} | WE MISSED: {len(missed)} | Coverage: {report['coverage']['coveragePct']}%")

    if caught:
        print(f"\n    -- CAUGHT (top 10) --")
        for c in caught[:10]:
            print(f"    {c['symbol']:12} ATH=${c['ath']:>8,} MC=${c['mc']:>8,} state={c.get('ourState','?')} traded={c['traded']}")

    if missed:
        print(f"\n    -- MISSED (top 15) --")
        for m in missed[:15]:
            reasons = ", ".join(m.get("missReasons", ["?"]))
            print(f"    {m['symbol']:12} ATH=${m['ath']:>8,} MC=${m['mc']:>8,} bonded={m['bonded']} WHY: {reasons}")

    print(f"\n  GATE COMPLIANCE")
    print(f"    Violations: {len(gate_violations)} | Stuck WATCHING: {len(stuck_watching)} | Stale: {len(stale_tokens)}")
    for gv in gate_violations:
        print(f"    !! {gv['symbol']} armed but {gv['failedGate']} fails: {gv['reason']}")

    print(f"\n  ERROR ACCOUNTING")
    print(f"    Spot-checked: {len(sample)} tokens")
    print(f"    Data errors found: {len(data_errors)}")
    for de in data_errors:
        print(f"    [{de['type']}] {de.get('symbol','?')}: {de.get('source','')}")
    if not data_errors:
        print(f"    No data integrity issues found in spot checks")

    print(f"\n  POSSIBLE ERROR SOURCES (to account for in analysis)")
    print(f"    - PumpPortal: can misclassify buy/sell, report stale solAmount, silently drop subscriptions")
    print(f"    - Our bot: MC direction override can flip sells to buys for catalyst, floor detection on thin data")
    print(f"    - Pump.fun API: phantom MC (real_sol=0 but high MC), stale ATH, delayed migration status")

    print(f"\n  RECOMMENDATIONS FOR NEXT SESSION")
    if recommendations:
        for i, rec in enumerate(recommendations, 1):
            print(f"    {i}. {rec}")
    else:
        print(f"    No critical issues found")

    print(f"\n  Log saved to: {logfile}")
    print(f"{'='*80}\n")

    return report


if __name__ == "__main__":
    run_review()
