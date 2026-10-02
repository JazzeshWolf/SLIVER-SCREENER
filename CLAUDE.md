# Metals Screener — working notes

The product, architecture and scoring engine are described in `README.md`; the
backlog is `TODO.md`; the audit is `AUDIT.md`. This file holds the operational
traps: the things that break silently or that a well-meaning change would undo.

## The moving parts

| Part | Where | Notes |
|---|---|---|
| Data builder | `scripts/build-data.mjs`, run by `.github/workflows/data.yml` | commits `public/data/{silver,gold,copper,crude,index,latest}.json` to **`main`** with ordinary commits — the git history of those files is the only snapshot archive |
| Site | `.github/workflows/deploy.yml` → GitHub Pages | the client reads the raw `main` copy of the data, so data commits don't redeploy |
| Telegram alerts | last step of `data.yml` → `scripts/alerts.mjs`, state on the `alerts-state` branch | see below |

## ⚠️ Scheduling: GitHub's cron is NOT keeping the advertised cadence

`data.yml` asks for every 10 minutes, 09:03–00:23 IST. Measured from the data
commits: ~13–25 runs a day until 26 Aug 2026, then **3–4 a day** since — at
about 14:00, 19:15 and 23:25 IST, plus a run around 02:00–03:00 IST (hours late).
Nothing lands in the morning session. Every run is `event: schedule`.

Consequences: the screen can be hours old, and a contract can cross the alert
bar and fall back between two runs without ever being reported. The fix the NSE
screener (JazzeshWolf/xerxes) uses is an external scheduler — cron-job.org
POSTing `workflow_dispatch` to
`https://api.github.com/repos/JazzeshWolf/SLIVER-SCREENER/actions/workflows/data.yml/dispatches`
with body `{"ref":"main"}` and a fine-grained PAT (Actions: read & write). Not
set up here yet; if it is, note the job and the PAT's expiry in the
credentials table.

## 🔑 Credentials & expiry (the things that will silently break this)

| Secret / variable | Where | Expires | Symptom when dead |
|---|---|---|---|
| `UPSTOX_ACCESS_TOKEN` | repo secret | ~1 yr from issue | runs succeed, `feed.upstox` = `auth_failed`, chain frozen; alerts hold every metal and the heartbeat goes ⚠️ |
| `TWELVEDATA_KEY`, `FRED_KEY` | repo secrets | n/a | macro factors drop out (partial), direction score weaker |
| `KITE_API_KEY`, `KITE_ACCESS_TOKEN` | repo secrets (optional fallback) | daily | nothing, unless Upstox is also dead |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | repo secrets — **the same bot and chat as xerxes** | never (revoke via @BotFather `/revoke` — which kills both screeners' alerts) | "Conviction alerts" step goes red; no end-of-day heartbeat |
| `ALERT_MIN_CONV_METALS` | repo **variable** (not a secret) | n/a | unset → the code default (60) |
| `ALERT_MIN_DTE_METALS` | repo **variable** | n/a | unset → the code default (10 days); `0` turns the minimum off |

Settings → Secrets and variables → Actions: secrets on the **Secrets** tab,
`ALERT_MIN_CONV_METALS` and `ALERT_MIN_DTE_METALS` on the **Variables** tab. Never paste the bot token into
a chat, an issue or a log line.

## Telegram conviction alerts (`scripts/alerts.mjs`, `alerts-state` branch)

The last step of `data.yml` messages the owner's Telegram bot — the one the NSE
screener already uses, same chat — when a strike on the Sell tab crosses the
bar, and follows it afterwards. Every message is headed **⚖️ MCX** and every
card carries the metal's emoji and contract (🥈 SILVERM / 🥇 GOLDM / 🟠 COPPER /
🛢️ CRUDEOILM), so it can't be mistaken for an NSE alert.

**Layout = the Xerxes one** (owner's ask, 2026-10-01): one card per contract and
expiry — `<b>🛢️ CRUDEOILM · 15 Oct</b>`, then "Monthly · N days left · lot 10
bbl", a 🔴 line if that expiry's VRP or event gate blocks selling, then a
`<pre>` table (monospace, copy button) with NEW / MOVED / DROPPED / REMOVED /
EXPIRED sections on one grid: strike+type, CONV (`72→78` for moves), PREM,
ROM (credit ÷ the screen's **broker-calibrated** margin per lot, %; ~2–4% on a
typical metals alert) and POP (the
model's chance it expires worthless). Tier emoji (⭐ 75+, 🔥 80+) sit only at a
row's end, where they can't shift a column; a REMOVED strike's reason goes on
an italic line under the table. Keep rows ~34 characters — wider wraps on a
phone and breaks the alignment. The replay counts events from `run()`'s
`onEvents` hook, not by parsing the text, so the layout can change freely.

| event | when |
|---|---|
| 🔔 NEW | a strike on the **displayed** list (Sell tab: top 8 per side per expiry), on the **current or next expiry**, with **10+ days to expiry**, reaches CONV ≥ 60 |
| ⬆️⬇️ MOVED | tracked, still above the bar, CONV changed by any amount |
| 🔻 DROPPED | tracked, fell below the bar → untracked (re-crossing is NEW again) |
| 🚪 LEFT | tracked, no longer scored: filtered out (the reason is printed — mostly "premium decayed"), in the money, off the fetched chain, or expiry day → untracked |

One message per run, **always with sound** — the owner explicitly asked for no
silent messages, moves included. Don't add `disable_notification` without
asking (a test pins it). Tiers: ⭐ 75+, 🔥 80+. Threshold
`ALERT_MIN_CONV_METALS`, default 60 (was 70 until 3 Oct 2026, owner's call: 213 replayed messages since 11 Aug instead of 171); entry minimum `ALERT_MIN_DTE_METALS`, default 10 days. Manual check: Actions → **Send test alert**
(tick *mock* for an invented alert through the real formatter, labelled MOCK;
tick *active* for a real one: the contracts the alerts follow right now, re-priced
on the latest snapshot, labelled TEST — it reads `alerts-state` but never writes it).

Things that will bite:
- **CONV is not in the snapshot.** The Sell tab computes it in the browser, so
  the alert recomputes it through `src/lib/sellView.ts` — the same module the
  tab renders from (`shortlist`, `SELL_TOP_N`, `mergeExpiry`, `decisionScore`).
  Keep the component on that module, or alerts fire for strikes the screen
  doesn't show. It is TypeScript, hence `npm ci` + vite-node in the alert step.
  Two inputs are browser-only (live-spot overlay on the direction score, the
  browser's own regime-hysteresis memory), so a CONV can sit a point or two
  off the phone's; the server's hysteresis memory lives in the state file.
- **Freshness is judged per metal, from the data.** The snapshot's `asOf` is
  bumped even when Upstox failed and the builder re-served last-good, so it
  proves nothing. A metal counts only if `stale` is false, `feed.chainOk`
  (a live chain *this* build), `feed.lastLiveAt` moved past the last one
  processed, that timestamp is inside MCX hours, and the chain fingerprint
  changed (holidays re-serve yesterday's prices under a new timestamp). A held
  metal's tracked strikes are neither reported nor dropped.
- **MCX hours are not NSE's.** 09:00 → 23:30 IST while the US is on daylight
  time (2nd Sunday of March → 1st Sunday of November), 23:55 IST otherwise —
  crude keeps the same session as the metals.
  Runs outside that — including GitHub's 02:00–03:00 IST stragglers — never alert.
- **Delivery is at-least-once.** State is written only after Telegram accepts
  every message; a failed send or state push turns the run red and the next
  run resends.
- **Never force-push `alerts-state`.** Unlike the data it is state, not a
  cache: a lost commit re-announces what it tracked or forgets an exit it never
  delivered. `scripts/alerts-state.sh` makes ordinary commits and rebases on a
  rejected push. The alert step runs on `main` only, so a feature-branch
  dispatch can't move it.
- **A missing state file arms instead of alerting**: one "✅ Alerts armed"
  message listing what is already above the bar, then normal operation.
  Deleting the `alerts-state` branch is the way to reset tracking without a
  flood. Arming waits for the first fresh in-session run.
- **The heartbeat** goes out on the first run after the close (so today:
  usually GitHub's 02:00–03:00 IST run): runs checked per metal, new/moves/exits,
  tracked count, ⚠️ naming any metal with zero fresh runs. No heartbeat by
  morning = the workflow didn't run after the close.
- **High CONV on metals mostly means short-dated.** Replaying 12 Aug–25 Sep
  2026: ~77% of NEW alerts at ≥ 70 fired with ≤ 10 days to expiry (median 6),
  in every band — `romAnnual` divides by tenor. The ⭐/🔥 tiers do not pick out
  longer-dated trades. Outcome history is too short and too correlated (2–3
  expiries per metal) to separate the bands: 90%+ of anything ≥ 55 expired OTM.
- **Volume scales with the scheduler, not the threshold.** With "any move"
  reporting, nearly every run that has something tracked sends a message: 3–4
  a day at today's cadence, ~20 a day during the mid-August cadence, and a
  10-minute scheduler would mean most of ~85 in-session runs.
- **Current and next expiry only** (`ALERT_EXPIRIES = 2`, owner's choice
  2026-09-25; the bar is 60 on every commodity since 3 Oct 2026; crude, added 2026-09-26, inherits both
  and the 10-day entry rule). Far months stay on the screen but never
  alert. An expiry on its last day (DTE 0) has no ranked strikes and gives up
  its slot, so on gold's 25 Sep expiry day the watch is Oct + Nov.
- **10+ days to expiry to enter** (`DEFAULT_MIN_DTE`, owner's choice
  2026-09-25). In the 11 Aug–25 Sep replay every losing alert was presented
  with 5 days or fewer left; the 68 first alerts with 10+ days all won (avg
  ₹7,101/lot vs ₹2,839 under 10). It gates **entry only**: a tracked strike
  keeps reporting moves and its exit as it runs under 10 days, and a re-cross
  under 10 days stays quiet. It does not remove scares: COPPER 1370 PE entered
  at 13 days and was ₹57,500/lot under water before expiring worthless.
  Replay volume: 159 messages instead of 281 over the same period.
- **The alerts do not score anything.** They call the Sell tab's own screen;
  moving its glue into `sellView.ts` was checked against `main` over 894
  archived snapshots (40,243 scored strikes) with zero differences. A change
  to CONV belongs in `sellCandidates.ts`, where the screen sees it too.
- MCX metal options list one expiry per month, so alerts carry no
  weekly/monthly label (the NSE engine's `isMonthly` has nothing to do here).
  Crude is monthly too (options ~2 business days before the future's ~19th).

## 🔒 Silver, gold and copper conviction is frozen (owner's rule, 2026-09-26)

The CONV rating for silver, gold and copper works — **do not change it**. That
covers their direction-engine weights, structural priors and macro pillar
(`engine` in `src/lib/metals.mjs`), their screener calibration (`screen`) and
the CONV blend in `src/lib/sellCandidates.ts`. `src/lib/frozen.test.ts` pins
every one of those numbers; if it fails, don't edit the numbers to make it
pass — ask the owner.

**The margin the screen shows is NOT frozen and is not CONV's** (owner, 3 Oct 2026).
`screen.priceScan` (±6/±4/±5%) is CONV's basis and stays. The separate
`margin.priceScan` (±20.4/±16.1/±16.2%) sizes the margin the screen displays,
calibrated to the owner's Sensibull margins: SILVERM 210000 PE ₹1.46L, GOLDM
160000 CE ₹1.36L, COPPER 1500 CE ₹3.26L, each 4.8–6.3× the CONV scan. EDGE, ROM,
tail % and the Telegram ROM column follow the shown margin. Don't feed it back
into CONV: scored on real margins, CONV drops ~10 points and the 70 bar would
fire about a third as often. Re-check against the broker if MCX revises margins.

Any change that touches shared code (a new commodity, a new factor, a builder
change) must leave their CONV byte-identical. Prove it the way the crude change
did: run `sellView` over archived snapshots before and after (crude: 34,220
scored strikes over 250 snapshots, zero differences) and compare
`npm run alerts:replay` output (crude: same 159 messages; only heartbeats
changed, because they now count crude). Crude's own numbers are free to tune.

## 🛢️ Crude oil (CRUDEOILM) — added 2026-09-26

Crude rides the same registry, builder, screen and alerts as the metals. Where
it differs, the difference is a registry field — keep it that way rather than
branching on `id === "crude"`:

- **Parity is the settlement rule** (`parityKind: "settlement"`): MCX crude
  settles on NYMEX WTI × the RBI rate, so no duty/GST and no domestic premium.
  The basis card and the Outlook's India-local driver ignore the gap by design.
  Don't "fix" it by adding levies.
- **The curve comes from the MCX strip** (`curveFrom: "mcx"`), and it is a
  scored factor for crude only (`termStructure`, backwardation = bullish). The
  Yahoo front-vs-spot fallback the metals use would compare crude's front
  future with itself; `source: "carry"` never counts as a curve. Don't weight
  `termStructure` for a metal: bullion sits in contango by construction.
- **No fixed structural opinion — the live curve is the supply read** (owner's
  call, 2026-09-26). Crude's `structuralBias` is 0 and unweighted; the weight
  sits on `termStructure` (1W .26, 1M .34), and `src/lib/curveRead.ts` states
  it in words on the Score tab, the Outlook and the curve card: "The live
  market says the futures curve is steeply backwardated (October ₹8,843, …),
  which signals a tight market." Don't reintroduce a hand-set OPEC+ prior —
  the first live run showed one ("supply overhang") contradicting a steeply
  backwardated, tight market.
- **Crude's margin is calibrated to the broker** (owner's Sensibull, 1 Oct
  2026: CRUDEOILM 15 Oct 7500 PE, future 8,883 → ₹27,392 a lot). That needs
  a ±46% `priceScan`; the vol-scaled ±8% the metals' logic suggests modelled
  ~₹3,100 and made EDGE read 11.5% of margin on a ~2% trade, inflating CONV.
  `metals.test.ts` pins the model within 10% of that figure. Don't "fix" the
  scan back toward the metals' range.
- **First live run is the real test.** Nothing here has met a live CRUDEOILM
  chain: check the Actions log for `upstox: CRUDEOILM N expiries` and
  `curve (MCX strip)`. If the instrument master has no CRUDEOILM options, the
  builder logs the CRUDEOIL rows it did find and crude stays `est.` — and the
  heartbeat goes ⚠️ naming Crude Oil every night until it is fixed.
- **Its first fresh run announces what is already above the bar as NEW.**
  Arming is per state file, not per metal, so adding a commodity to a live
  state sends one ordinary message listing crude's strikes ≥ 70 (10+ days).
- The replay has no crude history until the cron has committed some.

Replay the archive through the real engine (prints, never sends):
`git fetch --depth=5000 origin main && npm run alerts:replay -- --since 2026-09-01 [--threshold 75] [--min-dte 0] [--quiet]`.
Dry-run one live run: `ALERTS_DRY_RUN=1 ALERTS_STATE_DIR=/tmp/s npm run alerts`.
