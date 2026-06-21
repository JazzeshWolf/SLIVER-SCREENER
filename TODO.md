# Sliver Screener — Backlog

## 🔴 Next up
- [ ] **Full-fledged audit — the Good, the Bad & the Ugly.** End-to-end review of the whole
  system: data sources (are they live, accurate, fresh?), the scoring/outlook math, the options
  math (Black-76, prob-of-touch), the UI, and the failure modes. Output a plain-English report:
  - **Good** — what is solid and trustworthy.
  - **Bad** — what is weak, approximate, or hand-set (and how much to trust it).
  - **Ugly** — what is broken, stale, faked, or could silently mislead a real trade.

## 🟡 Nice to have
- [ ] AI brief upgrade for News (Anthropic key → smart impact score + "why it matters" per headline).
- [ ] Visual polish pass (spacing, charts, motion).
- [ ] COMEX / SLV inventory feed (best-effort — no clean free API yet).

## ✅ Done
- [x] Multi-horizon directional score (1D/1W/1M) + regime + hysteresis.
- [x] Premium-sell window (P-score) + theta ring.
- [x] Expected-move cone + event radar.
- [x] Context tab (correlations + basis + CoT).
- [x] Outlook tab (weighted 30-day synthesis, 8 drivers, seller playbook).
- [x] News tab (Google News RSS, silver-filtered, impact tags).
- [x] Server-side data via GitHub Actions (Upstox MCX, Twelve Data, CFTC, FRED).
- [x] Persistent silver history (mergeByDate — never reverts real → estimated).
- [x] No-cache headers + build marker.
