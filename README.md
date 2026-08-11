# ⚖️ Metals Screener

**Live:** https://jazzeshwolf.github.io/SLIVER-SCREENER/

A free, mobile-first, **static** dashboard for selling **MCX metal options** — 🥈 **Silver**,
🥇 **Gold** and 🟠 **Copper**. Pick a metal on open; each gets its own data file, its own factor
weights and its own narrative. It answers three questions at a glance:

1. **Which way is the wind blowing?** — a multi-horizon (1D / 1W / 1M) directional sentiment engine
   that resolves to a **regime** (trend vs chop) and the structure to sell.
2. **Should I be selling premium now?** — a Premium-Sell traffic light (IV rank, IV/RV, theta zone,
   event clearance) plus a theta-decay countdown ring.
3. **Are my sold strikes safe?** — an expected-move cone with per-strike cushion (σ) and
   probability-of-touch, an event radar, and basis/expiry convergence tracking.

Two **hard gates** sit on top of the premium-sell score and can override it outright:

- **VRP** — `ATM IV − RV20` in vol points. Below zero, selling is blocked: you are being paid less
  than the metal actually moves. When IV is a realized-vol *proxy* the VRP is mechanically positive
  and is flagged as meaningless rather than shown as comfort.
- **Event VETO** — a weight-3 print (FOMC / CPI / NFP) within ~3 sessions forces the card red;
  major prints later in the holding window are flagged as "defined risk only" rather than vetoed,
  because a whole-window veto would fire nearly every month and train you to ignore it.

> **It is a decision aid, not a signal.** The directional weights are hand-set priors, **not
> backtested** — and there are now three sets of them. Trust the *regime*, the horizon *divergence*
> and the two gates, not the decimal. Silver's tails are violent and copper's book is thin — short-vol
> positions still need defined risk.

## The three metals

They are different assets wearing the same exchange, so almost nothing is shared but the plumbing.

| | 🥈 Silver | 🥇 Gold | 🟠 Copper |
|---|---|---|---|
| Contract | SILVERM (5 kg) | GOLDM (100 g) | COPPER (2500 kg) |
| Quote | ₹/kg | **₹/10g** | ₹/kg |
| ₹ per lot | prem × 5 | prem × **10** | prem × 2500 |
| Parity | $/oz × 32.1507 | $/oz × 0.3215 | $/lb × 2.20462 |
| Duty + GST | 15% + 3% | 15% + 3% | 5% + 18% |
| Heaviest factor | dollar / momentum | **real yields** (.23) | **dollar** (.18) |
| Cross-metal | gold leadership | GSR (sign flipped) | **copper/gold ratio** |
| Structural prior | deficit +0.6 | central banks +0.2 | concentrate +0.3 |
| Sell screener | OI ≥ 25 | OI ≥ 25 | **OI ≥ 100, chain ≥ 1,500** |

- **GOLDM is quoted per 10 g but sold in 100 g lots**, so ₹/lot is premium × 10, not × 100. The
  registry field is called `quoteUnitsPerLot` precisely so that error is hard to write.
- **Copper's basis is approximate and labelled as such.** MCX copper tracks LME, but the only free
  daily feed is COMEX, and the US §232 tariff has held those hundreds of dollars a tonne apart.
  Read the direction, not the level.
- **Copper has no free CORS spot API**, so it has no browser-side live overlay — it refreshes on the
  server's ~10-minute cadence only.
- **Copper's option book is genuinely thin.** Below 1,500 total chain OI the sell screener refuses to
  rank at all and says so, rather than producing a confident shortlist of unfillable strikes.

## Architecture ($0)

```
Free CORS APIs ─(live, in browser)─┐
 gold-api · frankfurter · stooq ·   ├─► Preact SPA ─► GitHub Pages
 FRED                                │      ▲
GitHub Actions cron ─(every 10m)─────┘      │ reads
 scripts/build-data.mjs ─► public/data/latest.json (committed)
```

- **Live half** (spot XAG/XAU, USD-INR, DXY, real yields) is fetched **client-side** from free,
  CORS-enabled APIs. No backend, no keys required (FRED key optional for real-yield history).
- **MCX half** (futures, OI, option IV, basis) has no free browser-callable API, so a **GitHub
  Actions cron** acts as a serverless backend: it runs `scripts/build-data.mjs` during market hours
  and commits one snapshot per metal. Data is ~10 min delayed — fine for a premium seller.
- The builder fetches **shared macro once** (dollar, rates, rupee, gold, US prints) and the MCX
  instrument master once, then loops the metals **sequentially** — three metals × four expiries ×
  ~50 option quotes would burst Upstox's rate limit inside a 10-minute cron. Fail-soft is **per
  metal**: a dead copper feed cannot blank out silver.

```
public/data/index.json    picker cards (price, %chg, IV rank, VRP, health) — small, loads first
public/data/silver.json   full snapshot: live macro + MCX contract + chain + expiries + COT + news
public/data/gold.json
public/data/copper.json
public/data/latest.json   byte-identical silver copy, kept for older deployed clients
```
- Every fetch **fails soft**: on error it falls back to the last-good cached value and flags the UI
  (`partial` / `stale`) rather than showing blanks or fabricated numbers.

## Tech

Preact + Vite + TypeScript + Tailwind v4. Charts are hand-rolled SVG (no chart lib) → ~17 KB gzipped.

## Develop

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests (scoring, options math, stats)
npm run build      # type-check + production build to dist/
npm run build:data # run the data builder locally (fail-soft without an MCX source)
```

## The metal registry (`src/lib/metals.mjs` + `metals.d.mts`)

One source of truth for every per-metal constant: lot multipliers, parity, duty/GST, feed symbols,
COT codes, COMEX delivery months, news queries, factor weights and screener calibration. Written as
`.mjs` with a companion `.d.mts` because it has two consumers with different runtimes — the strict-TS
client and the plain-ESM builder. Before it existed the parity constants lived in *both*
`src/lib/basis.ts` and `scripts/build-data.mjs` and were kept in sync by hand.

Every metal's parity collapses to one formula, `intl × unitMult × usdInr × (1 + duty + gst)`, which
is why the registry can stay pure data. **Strike step is derived from the live chain** (median gap),
never hardcoded — MCX moved gold's option interval from ₹100 to ₹500 in Jan 2026.

## The scoring engine (`src/lib/scoring.ts`)

- **Directional score `S(h)`** for `h ∈ {1D, 1W, 1M}`: `S = 10 × Σ(wᵢ·sᵢ) × confidence`. Short windows
  + price-led weights on 1D, slow windows + structural-bias weight on 1M. Z-scores are **winsorized
  to ±2.5σ**; each factor is clipped to [−1, +1].
- **Factor weights are per metal** (`factorConfigFor(metalId)`), written out as a full table per
  horizon in the registry so each column visibly sums to 1. Real yields are gold's heaviest factor
  and near-irrelevant to copper; copper swaps gold leadership for the copper/gold growth ratio; the
  gold-silver ratio has two keys so its sign flips correctly between the silver and gold screens.
- Factors are tagged with one of four **pillars** (Global / Derivatives / Technicals / INR & domestic)
  for display, so the breakdown reads in the same vocabulary as the bullion verdict playbook.
- **Robustness:** missing factors are **dropped and their weight redistributed** pro-rata (never a
  silent 0). `confidence(h)` shrinks the score toward 0 on stale / sparse / low-breadth data.
- **Regime mapper:** horizon agreement → `trend_up` / `trend_down` / `chop` / `no_conviction`, with
  **hysteresis** so the badge doesn't flicker. A directional lean is only offered when the
  DTE-matched horizon (1W weeklies, 1M monthlies) clears the conviction threshold.
- **Premium-Sell score `P` (0–100):** `0.40·IVrank + 0.25·(IV/RV) + 0.20·thetaZone + 0.15·eventClear`,
  renormalized over whatever components are available.

Options math (`src/lib/options.ts`) is Black-76: IV solver (Newton + bisection fallback), delta,
expected move, probability-of-touch, strike cushion, and a closed-form CVaR for a short leg. Basis
math (`src/lib/basis.ts`): `FV = XAGUSD × 32.1507 × USD-INR × (1 + duty + GST)`.

## The sell screener (`src/lib/sellCandidates.ts`)

The **Sell** tab ranks every OTM leg on the chain and surfaces the *balanced* strikes. Sorting on
any single column degenerates: premium picks ATM (where short options blow up), P(OTM) picks the
furthest strike (which earns nothing), and *edge* is worst of all — MCX silver IV sits well above
realized vol, so every strike shows positive edge and the sort collapses into "furthest and least
liquid wins". So `CONV` (0–100) blends six normalized sub-scores: return on margin (0.28), forecast
P(OTM) (0.22), tail loss (0.18), liquidity (0.12), that strike's own vol richness (0.10) and
probability-of-touch (0.10) — then shrinks the result by a data-confidence factor and applies a
bounded ±8-point tilt for agreeing with the regime.

- **Forecast measure.** `P(OTM)`, fair value and CVaR are computed under `σ = 0.6·RV20 + 0.4·ATM IV`
  with a drift from the direction engine capped at 0.5σ — deliberately *not* risk-neutral, so
  P(OTM) is a forecast rather than a restatement of 1−|Δ|. Probability-of-touch stays risk-neutral
  at the strike's own IV, because "will the market test me" is a market-price question.
- **Filters.** A leg is rejected (with the reason shown, never silently dropped) for: no solvable
  IV, OI < 25, premium < 0.15% of the future, cushion < 0.6σ, or sitting **off the fitted smile** —
  a least-squares quadratic in log-moneyness. That last test is the important one: a leg that last
  traded days ago shows a large fake edge, and an OI floor alone doesn't catch it.
- **Margin is modelled, not the exchange's.** MCX SPAN isn't in any free feed, so `spanScanMargin`
  revalues the short leg across a ±6% price × ±25% vol scan grid, floors it at 0.5% of the future
  and adds the blocked premium. Every margin-derived column is labelled `est.`; type your broker's
  real ₹/lot into the override to replace it.

> The CONV weights are hand-set priors, not backtested — same caveat as the direction engine. Trust
> the shortlist and the columns, not the second decimal.

## The MCX data source (token-free Bhavcopy)

`scripts/build-data.mjs` pulls the **MCX daily Bhavcopy** from the public market-data endpoint
(`GetDateWiseBhavCopy`) — no login, no token. It primes session cookies, walks back day-by-day to
the latest available bhavcopy (handles weekends/holidays), then `scripts/bhavcopy.mjs` selects the
front-month `SILVER` future + its option chain and maps them to the pipeline shape. OI change is
diffed against the previous trading day. Override the symbol with the `MCX_SYMBOL` env (e.g.
`SILVERM` for the mini).

Parsing/selection is split into pure functions in `scripts/bhavcopy.mjs` and unit-tested
(`bhavcopy.test.mjs`) against a fixture, since MCX field casing varies. Everything downstream (IV,
IV-rank from `history.jsonl`, expected move, basis) is computed from the selected raw inputs.

> **Caveat:** MCX sits behind bot protection. From a GitHub Actions runner the browser-like headers
> + cookie prime usually suffice, but if the endpoint starts returning 403 the builder **fails soft**
> (keeps the last-good snapshot, flags it `stale`) rather than emitting bad data. If that happens,
> swap in the Kite path (set `KITE_API_KEY` / `KITE_ACCESS_TOKEN` secrets — note the token expires
> daily) as a fallback.

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on push to `main`. Enable Pages
(Settings → Pages → Source: GitHub Actions). If your repo isn't named `sliver-screener`, set the
`BASE_PATH` env at build time to match the Pages sub-path.
