# Sliver Screener — Full System Audit

**Date:** 2026-06-21 · **Scope:** end-to-end (data → math → UI → security/cost)
**Method:** read the actual source + the live `latest.json`; key numbers re-derived by hand.
**Verdict in one line:** the **engine is well-built and the core conversion/options math is provably correct**, but the **vol/IV layer and two major macro inputs are running on proxies or missing**, and the **UI overstates confidence** about it.

Severity key: 🔴 could mislead a real trade · 🟡 weak/approximate, know the limits · 🟢 solid.

---

## ✅ Fixes applied (2026-06-21)

| Finding | What changed | Status |
|---|---|---|
| U1 — IV was a realized-vol proxy | Root cause found: options match the FUTURE's expiry, but MCX silver options expire on a different date, so zero matched. Fixed `pickContract` to use the options' own expiry → **verified live: 308 options found, real ATM IV 59.5% solved from 17 option LTPs (IV/RV 1.72).** | **Fixed & verified live** |
| Refinement (from U1) — wrong expiry drove seller widgets | Theta/expected-move/premium-sell/decision-horizon now use the OPTION expiry (36 DTE), not the future's (8 DTE). **Verified live.** | **Fixed & verified live** |
| U1 (symptom) — proxy could masquerade as live IV | Added `ivEstimated` flag through the snapshot + types; `SpotStrip` shows **"ATM IV\*"** and `SellWindow` warns when IV is a proxy. | **Fixed** |
| U3 — confidence overstated when macro missing | `scoring.ts` now caps horizon confidence (×0.6 floor) when DXY/real-yield are absent. With the live data this drops 1M confidence ~1.0 → ~0.6. All 38 tests pass. | **Fixed** |
| U4 — IV Rank ≠ Percentile (duplicate) | `ivPercentile` now a true share-at-or-below percentile, distinct from the min-max `ivRank`. | **Fixed** |
| U2 — real yields missing | `FRED_KEY` added → real 10y yield + breakeven now live (2.23% / 2.26%). | **Fixed** |
| U2 — Dollar (DXY) missing | Added Fed Broad USD Index via FRED (`DTWEXBGS`) as the dollar source — ICE DXY free feeds block GitHub IPs. Live at 119.5 (broad-index scale), labelled "USD idx" in the UI. Direction is what the engine uses. | **Fixed** |
| B5 — data URL pinned to dev branch | Reviewed: that branch **is** the deploy branch, so the pin is correct. No change. | **No action** |

Verified: `npm test` (38 pass), `npm run build` (clean), both data scripts `node --check` clean, IV solver round-trip exact.

---

## 🔴 The Ugly — fix before trusting these for real money

### U1. "ATM IV" is a realized-vol proxy, not market implied vol
- **Evidence:** live file `options.atmIv = 0.3587`, `options.chain = []`. In `build-data.mjs:598`, when the Upstox option chain is empty, `atmIv` falls back to `rv20 * 1.05`. Check: `rv20 = 0.3416 × 1.05 = 0.35868 → 0.3587`. **Exact match — the IV shown is realized vol ×1.05, not a traded option price.**
- **Root cause:** `upstox.optionChain(token, c.future.key, …)` (`build-data.mjs:406`) passes the **future's** instrument key. Upstox's `/option/chain` expects the **underlying** key — so it returns nothing, the chain is empty, and IV silently falls back to the proxy.
- **Why it matters:** IV feeds the Premium-Sell Window, the expected-move cone, IV/RV, and "am I safe." Right now the whole vol read is realized-vol wearing an IV label. `estimated:false` (because price/OI are real), so **nothing flags the IV as a proxy.**
- **Fix:** pass the correct underlying key to `/option/chain` (or derive the chain from the option instruments already in `pickContract`). Until then, label IV as "est. (from realized vol)" in the UI.

### U2. The two biggest macro drivers — Dollar (DXY) and real yields — are entirely missing
- **Evidence:** live file `dxy:null`, `real10y:null`, `dxyHistory:[]`, `real10yHistory:[]`.
  - DXY: `fetchSeries("dxy",{td:["DXY"],yahoo:"DX-Y.NYB",stooq:"^dxy"})` — Twelve Data free tier doesn't serve `DXY`, and Yahoo/stooq block GitHub's cloud IPs. Result: empty, and `build-data.mjs:523` deliberately drops it rather than carry a bad series.
  - Real yields: `fredSeries("DFII10")` returns `[]` with no `FRED_KEY` set. **FRED_KEY is not configured.**
- **Why it matters:** in `scoring.ts` DXY + real10y carry the **heaviest weights** (1D: 0.24 + 0.18 = **42%** of nominal weight; 1M: 0.27). With both dark, the "macro" direction read is really just silver momentum + gold momentum + OI + USD-INR. The headline feature is running half-blind.
- **Fix (cheapest first):** add `FRED_KEY` (free) → real yields + breakeven come live immediately. For DXY, compute a synthetic dollar proxy from the USD-INR/gold series already present, or add a keyed source that serves DXY.

### U3. Confidence is overstated — the gate is satisfied *without* the macro factors
- **Evidence:** `horizonConfidence` (`scoring.ts:176`) = `coverage × historyFactor × breadth × stale`. With DXY/yields gone, the 1M present-weight is silver 0.12 + gold 0.11 + OI 0.12 + INR 0.10 + GSR 0.08 + deficit 0.20 = **0.73**, and `coverage = clamp(0.73/0.6 …) = 1.0`. History (~160 gold pts) and breadth (6 factors) also max out → **confidence ≈ 1.0 while the two biggest inputs are missing.**
- **Why it matters:** the gauges and Outlook read as high-confidence when they shouldn't. (Mitigating: `RegimeCard` *does* show a "partial data" pill and lists DXY/yields as `n/a` with strikethrough in the factor breakdown — so it's disclosed if you open the accordion, just not reflected in the confidence number or the gauges.)
- **Fix:** make `coverage` penalise missing *named heavy* factors, not just total weight — e.g. cap confidence when DXY **or** real-yield is absent, since they're the macro pillars.

### U4. "IV Rank" / "IV Percentile" are mislabeled and identical
- **Evidence:** `ivRank = ivRankFrom(rv20)` ranks **realized vol** in its own range (`build-data.mjs:587, 599`); `ivPercentile: ivRank` (`:661`) just copies it. So both numbers are (a) realized-vol, not IV, and (b) the same value shown under two different concept names. `rangeRank` is also min-max based, so the single Jan vol blow-up pins the top of the range and forces today to ~3.
- **Why it matters:** IV Rank is **40% of the Premium-Sell score** and the seller's primary "is premium rich?" read. A value of 2.9 says "don't sell" — built on the wrong quantity and a short, partly-estimated, spike-sensitive history.
- **Fix:** accumulate a history of real ATM IV (once U1 is fixed) and rank against *that*; use `percentRank` for percentile and `rangeRank` for rank (they should differ); relabel honestly until real IV history exists.

---

## 🟡 The Bad — approximate; know the limits

- **B1. Expected-move cone has no per-strike data.** `chain:[]` (same root cause as U1) means the "your sold strike cushion / probability-of-touch" visual has no option strikes to work with — the core "am I safe?" feature is dataless until the chain is fixed.
- **B2. The structural-deficit constant is oversized when macro is missing.** `deficitBias` is a hardcoded **+0.6 bull** at weight 0.20 on 1M (`scoring.ts:86,92`). With DXY/yields gone it redistributes to ~27% of the 1M score = a baked-in **+1.6 bull floor** before any live data. Defensible (the deficit is real) but it's doing more work than intended right now.
- **B3. News impact tags misclassify direction.** Keyword tagger (`build-data.mjs:250-256`) tags "Silver Rally **Stalls** as Fed Kills Rate Cut Hopes" as `up` (it's bearish) — the word "rally" matches a bull keyword. Several headlines are mis-signed. (This is the real case for the optional AI brief.)
- **B4. USD-INR level looks high (94.3 vs real-world ~86).** It moves as a smooth, internally-consistent series, so it's not garbage — but verify the live source is genuinely current, not a stale/placeholder series.
- **B5. Live data URL is pinned to the dev branch.** `fetchers.ts:16` hardcodes `…/claude/wizardly-pasteur-58a976/…`. If that branch is ever merged/renamed, the live app stops getting fresh data. Point it at a stable branch.
- **B6. Dead fallback code.** `fetchMcxReal()` + the whole `bhavcopy.mjs` path are imported but never called in `main()`. Harmless, but it's untested dead weight implying a fallback that isn't wired.

---

## 🟢 The Good — solid, trust it

- **G1. Conversion chain is correct to the rupee.** `XAG 64.96 × 32.1507 × INR 94.33 × 1.18 = 232,471`; file says fair value **232,474**. Constants (oz/kg, 15% duty, 3% GST) all correct (`basis.ts`).
- **G2. Basis & expected-move arithmetic correct.** Basis 237,300 − 232,474 = **4,826** ✓. Expected move 237,300 × 35.87% × √(10/365) = **14,089** ✓.
- **G3. Options math is textbook-correct.** Black-76 price/vega, the Newton+bisection IV solver (returns `null` rather than guessing), probability-of-touch (reflection principle), probability-above/below (risk-neutral) are all correct (`options.ts`). The *engine* is sound — it's the *inputs* (U1) that are proxied.
- **G4. CoT data is genuinely high quality.** Real CFTC weekly cadence, 18 months of history, sane values, correct percentile, kept last-good when lagged (`build-data.mjs:199-239`).
- **G5. Persistence works as designed.** `mergeByDate` + the Upstox→last-good-real→parity ladder (`build-data.mjs:553-620`) never reverts real data to an estimate on a transient hiccup — verified in the logic.
- **G6. Robustness primitives are actually implemented, not just claimed.** Winsorization to ±2.5σ, pro-rata weight redistribution for missing factors, confidence gating, and regime hysteresis all exist and work (`stats.ts`, `scoring.ts`).
- **G7. Security & cost are clean.** All secrets are server-side in GitHub Actions env only; the client reads a public JSON; the Upstox token is read-only analytics; the whole thing is $0. No keys in the client bundle.
- **G8. Honest disclosure exists (partially).** `RegimeCard` shows a "partial data" pill and strikes through missing factors; `SpotStrip` flags stale/partial core feeds; the methodology footer admits the weights are hand-set priors.

---

## Prioritized fix list

| # | Fix | Effort | Payoff |
|---|-----|--------|--------|
| 1 | **Add `FRED_KEY`** (free) → real yields + breakeven come live | 2 min | Restores one of the two missing macro pillars |
| 2 | **Fix the Upstox option-chain call** (U1/B1) → real IV + strike cushion | Medium | Fixes IV, expected move, cone, sell-window all at once |
| 3 | **Penalise confidence when DXY/yields are absent** (U3) | Small | Stops the UI implying certainty it lacks |
| 4 | **Relabel IV Rank/Percentile honestly** until real IV history exists (U4) | Small | Stops a wrong-quantity number driving the sell decision |
| 5 | **Add a real DXY source** (or synthetic proxy) (U2) | Medium | Restores the second macro pillar |
| 6 | Repoint the live data URL off the dev branch (B5) | 1 min | Removes a single point of failure |
| 7 | AI news brief (optional) → fixes mis-signed impact tags (B3) | Medium | ~$2–3/mo; nicer, not essential |

**Bottom line:** this is a genuinely well-engineered system with correct core math and clean security — not "random shit." The data that's present is mostly real and internally consistent. The real risks are (1) the vol/IV layer is a proxy because of one wrong API parameter, (2) two macro pillars are missing, and (3) the confidence number doesn't admit either. Fixes 1–4 above address the trade-affecting items and are mostly small.
