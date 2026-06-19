# 🥈 Sliver Screener

**Live:** https://jazzeshwolf.github.io/SLIVER-SCREENER/

A free, mobile-first, **static** dashboard for selling **MCX Silver options**. It answers three
questions at a glance:

1. **Which way is the wind blowing?** — a multi-horizon (1D / 1W / 1M) directional sentiment engine
   that resolves to a **regime** (trend vs chop) and the structure to sell.
2. **Should I be selling premium now?** — a Premium-Sell traffic light (IV rank, IV/RV, theta zone,
   event clearance) plus a theta-decay countdown ring.
3. **Are my sold strikes safe?** — an expected-move cone with per-strike cushion (σ) and
   probability-of-touch, an event radar, and basis/expiry convergence tracking.

> **It is a decision aid, not a signal.** The directional weights are hand-set priors, **not
> backtested**. Trust the *regime* and horizon *divergence*, not the decimal. Silver's tails are
> violent — short-vol positions still need defined risk.

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
  Actions cron** acts as a serverless backend: it runs `scripts/build-data.mjs` during market hours,
  computes everything, and commits `public/data/latest.json`. Data is ~10 min delayed — fine for a
  premium seller.
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

## The scoring engine (`src/lib/scoring.ts`)

- **Directional score `S(h)`** for `h ∈ {1D, 1W, 1M}`: `S = 10 × Σ(wᵢ·sᵢ) × confidence`. Same factors
  across horizons; short windows + price-led weights on 1D, slow windows + structural-bias weight on
  1M. Z-scores are **winsorized to ±2.5σ**; each factor is clipped to [−1, +1].
- **Robustness:** missing factors are **dropped and their weight redistributed** pro-rata (never a
  silent 0). `confidence(h)` shrinks the score toward 0 on stale / sparse / low-breadth data.
- **Regime mapper:** horizon agreement → `trend_up` / `trend_down` / `chop` / `no_conviction`, with
  **hysteresis** so the badge doesn't flicker. A directional lean is only offered when the
  DTE-matched horizon (1W weeklies, 1M monthlies) clears the conviction threshold.
- **Premium-Sell score `P` (0–100):** `0.40·IVrank + 0.25·(IV/RV) + 0.20·thetaZone + 0.15·eventClear`,
  renormalized over whatever components are available.

Options math (`src/lib/options.ts`) is Black-76: IV solver (Newton + bisection fallback), expected
move, probability-of-touch, strike cushion. Basis math (`src/lib/basis.ts`):
`FV = XAGUSD × 32.1507 × USD-INR × (1 + duty + GST)`.

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
