# Metals Screener — Backlog

## 🔴 Next up
- [ ] **Wire the physical/flows driver live.** It is the last placeholder on the Outlook tab and is
  labelled "not yet wired live" on every metal. CME publishes free daily warehouse stocks at
  `cmegroup.com/delivery_reports/{Copper,Gold,Silver}_Stocks.xls` (no key) — parse defensively, fail
  soft, and only promote it from a narrative driver to a **scored** factor once a CI run proves the
  parse. Copper wants LME + SHFE too; neither has a clean free feed yet.
- [ ] **Copper basis on LME, not COMEX.** `parityConfidence: "approximate"` is honest but it is still
  the wrong anchor: MCX tracks LME while the only free feed is COMEX, and §232 has held them
  hundreds of dollars a tonne apart. westmetall.com publishes LME cash/3M free — if it parses,
  switching is a one-line registry change (`unitMult: 0.001`, `intlUnit: "$/t"`).
- [ ] **Check crude's OI floors against the live book** (`minOi` 25, `minChainOi` 500). The live
  pipeline is verified (CRUDEOILM chain, ₹50 steps, MCX-strip curve, CFTC 067651) and the margin is
  calibrated to the broker (see ✅). If MCX changes crude's margins, re-check `priceScan` against the
  broker and update the pinned figure in `metals.test.ts`.
- [ ] **Verify gold + copper live in CI.** Local runs have no Upstox token, so GOLDM/COPPER chains
  have never been exercised against the real instrument master. First `workflow_dispatch` run should
  be checked for: real chain legs, sane ATM IV, derived strike step, and **₹/lot = premium × 10 on
  GOLDM** (the 10× trap).

## 🟡 Nice to have
- [ ] **Capture bid/ask + volume from Upstox** (`upstox.mjs` already reads `market_data`, but keeps
  only `ltp`/`oi`). Would let the sell screener price off the mid, apply a real spread filter, and
  demote the off-smile heuristic to a secondary check. Matters most for copper.
- [ ] LME cash–3M spread as a **scored** copper factor (backwardation = physical tightness).
- [ ] China demand proxy for copper — deliberately absent rather than faked; there is no clean free
  PMI/credit-impulse feed. Revisit if one appears.
- [ ] AI brief upgrade for News (Anthropic key → smart impact score + "why it matters" per headline).
  The keyword tagger still mis-signs headlines (AUDIT B3) and now runs on three metals' feeds.
- [ ] Per-metal seasonality note (bullion festive/wedding window; copper's CNY destock → Q2 restock).
- [ ] **Crude event calendar.** The EIA weekly petroleum report (Wednesdays) and OPEC+ meetings move
  crude more than the US prints do, but neither is on the radar yet: a weekly weight-1 event would
  zero the premium score's event component three days in seven, so it needs its own treatment
  rather than a line in `buildEvents`. OPEC+ dates are not published far ahead.
- [ ] Visual polish pass (spacing, charts, motion).

## ✅ Done
- [x] **Crude margin calibrated to the broker** (2026-10-01) — `priceScan` 8% → 46%, matching the
  owner's Sensibull margin of ₹27,392 for a CRUDEOILM 7500 PE. EDGE was reading ~9× too high.
- [x] **Crude reads its supply story live** — no fixed OPEC+ prior; the MCX futures curve carries
  that weight and the screen states it with the month prices (`src/lib/curveRead.ts`).
- [x] **Crude oil (CRUDEOILM)** — fourth commodity: registry entry (10 bbl lot, WTI × USD-INR
  settlement parity, CFTC 067651), its own factor table with the MCX futures curve as a scored
  factor, Outlook copy, per-metal wording on the shared cards, Telegram alerts (🛢️).
- [x] **Three metals** — silver, gold (GOLDM) and copper, chosen from a picker on open. Per-metal
  data files, factor weights, screener calibration and narrative.
- [x] **Metal registry** (`src/lib/metals.mjs` + `.d.mts`) — one source of truth shared by the
  strict-TS client and the plain-ESM builder; killed the duplicated parity constants.
- [x] **VRP gate + event VETO** — both override the premium-sell score outright; proxy IV is flagged
  rather than shown as comfort.
- [x] **Four-pillar factor breakdown** — same vocabulary as the bullion verdict playbook.
- [x] **Copper liquidity gate** — "chain too thin to sell" instead of ranking unfillable strikes.
- [x] **Symbol-collision fix** — `matchesSymbol` no longer lets GOLD swallow GOLDM or SILVER swallow
  SILVERM; `norm()` no longer classifies `OPTFUT` as a future.
- [x] **CI unpinned** from the dev branch; `test.yml` runs type-check + tests on every push.
- [x] **Full-fledged audit** — the Good, the Bad & the Ugly (see AUDIT.md).
- [x] Sell-candidate screener (CONV, off-smile filter, modelled SPAN margin).
- [x] Position tracker, trusted-source news filter, Event Radar v2, GEX card.
- [x] Real IV history accumulation; multi-horizon score + regime + hysteresis.
- [x] Expected-move cone, Context tab, Outlook tab, News tab.
- [x] Server-side data via GitHub Actions (Upstox MCX, Twelve Data, CFTC, FRED).
