// ---------------------------------------------------------------------------
// Dashboard data hook: loads the server-built snapshot, computes scores/regime/
// premium, manages refresh interval and regime hysteresis.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchSnapshot, fetchLiveSpot } from "../lib/fetchers";
import { DEFAULT_METAL, metalFor } from "../lib/metals.mjs";
import { deriveRegime, premiumSellScore, scoreAllHorizons } from "../lib/scoring";
import { walkForwardHitRate, type TrackResult } from "../lib/track";
import { buildOutlook, type Outlook } from "../lib/outlook";
import { basis, fairValue, premiumPct } from "../lib/basis";
import { metalForSymbol } from "../lib/instrument";
import { mergeExpiry, retimeSnapshot } from "../lib/expiry";
import type { MetalConfig } from "../lib/instrument";
import type { Snapshot } from "../lib/types";
import { cacheGet, cacheSet } from "../lib/cache";
import type {
  ExpiryBundle,
  Horizon,
  HorizonScore,
  LiveInputs,
  McxData,
  PremiumSellScore,
  Regime,
  RegimeResult,
} from "../lib/types";

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes
const SERVER_STALE_MIN = 20; // beyond this, prefer the browser's live spot

/** Replace today's point in a history with a fresher live value (or append). */
function withLive(hist: { t: string; v: number }[], v: number | null): { t: string; v: number }[] {
  if (v == null || !Number.isFinite(v)) return hist;
  const today = new Date().toISOString().slice(0, 10);
  return [...hist.filter((p) => p.t !== today), { t: today, v }];
}

/**
 * Overlay browser-fetched live spot onto the server snapshot. When the server
 * snapshot is stale, also derive a live parity-implied MCX price (spot × parity
 * + last known basis) so the headline, positions and cone update on refresh and
 * stay internally consistent. Flags `liveParity` so the UI labels it honestly.
 */
function applyLiveSpot(
  snap: Snapshot,
  spot: { metalUsd: number | null; xauUsd: number | null; usdInr: number | null },
): Snapshot {
  const metalUsd = spot.metalUsd ?? snap.live.metalUsd;
  const xauUsd = spot.xauUsd ?? snap.live.xauUsd;
  const usdInr = spot.usdInr ?? snap.live.usdInr;
  const live = {
    ...snap.live,
    metalUsd,
    xauUsd,
    usdInr,
    metalHistory: withLive(snap.live.metalHistory, spot.metalUsd),
    xauHistory: withLive(snap.live.xauHistory, spot.xauUsd),
    usdInrHistory: withLive(snap.live.usdInrHistory, spot.usdInr),
    asOf: new Date().toISOString(),
  };

  const ageMin = (Date.now() - new Date(snap.mcx.asOf).getTime()) / 60000;
  const canImply = spot.metalUsd != null && spot.usdInr != null && snap.mcx.mcx.fut != null;
  if (ageMin <= SERVER_STALE_MIN || !canImply) return { live, mcx: snap.mcx };

  // Server MCX is stale — carry the last basis onto live parity for a live price.
  // Parity constants come from whichever metal the snapshot is actually for.
  const liveFv = fairValue(metalForSymbol(snap.mcx.mcx.symbol), metalUsd, usdInr);
  const serverBasis = snap.mcx.basis.basis ?? 0;
  const impliedFut = liveFv != null ? Math.round(liveFv + serverBasis) : snap.mcx.mcx.fut;
  const mcx = {
    ...snap.mcx,
    liveParity: true,
    mcx: { ...snap.mcx.mcx, fut: impliedFut },
    basis: { fairValue: liveFv != null ? Math.round(liveFv) : snap.mcx.basis.fairValue, basis: serverBasis },
  };
  return { live, mcx };
}

export interface Dashboard {
  live: LiveInputs | null;
  mcx: McxData | null;
  expiries: ExpiryBundle[] | null;
  selectedExpiry: string | null;
  setSelectedExpiry: (optionExpiry: string) => void;
  scores: Record<Horizon, HorizonScore> | null;
  regime: RegimeResult | null;
  premium: PremiumSellScore | null;
  outlook: Outlook | null;
  track: TrackResult | null;
  derived: {
    /** The metal this snapshot is for, resolved from the feed's own symbol. */
    metal: MetalConfig;
    fairValue: number | null;
    basis: number | null;
    premiumPct: number | null;
    gsr: number | null;
  } | null;
  loading: boolean;
  lastUpdated: string | null;
  refresh: () => void;
}

export function useDashboard(metalId: string = DEFAULT_METAL): Dashboard {
  const [live, setLive] = useState<LiveInputs | null>(null);
  const [mcx, setMcx] = useState<McxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const id = metalFor(metalId).id;

  const load = useCallback(async () => {
    setLoading(true);
    const snap = await fetchSnapshot(id);
    if (snap) {
      // Overlay live browser-fetched spot so ⟳ genuinely updates prices even
      // when the server snapshot is stale; falls back to server values if the
      // live fetch is blocked/fails. Copper has no free CORS spot API, so this
      // returns null there and the server cadence is all there is.
      const spot = await fetchLiveSpot(id).catch(() => null);
      const merged = spot ? applyLiveSpot(snap, spot) : snap;
      setLive(merged.live);
      setMcx(merged.mcx);
      setLastUpdated(spot ? new Date().toISOString() : snap.mcx?.asOf ?? new Date().toISOString());
    } else {
      // Switching to a metal with no data yet must not leave the previous
      // metal's numbers on screen under the new metal's name.
      setLive(null);
      setMcx(null);
    }
    setLoading(false);
  }, [id]);

  // Reset per-metal view state when the metal changes, so a silver expiry can
  // never stay selected while gold's chain is rendering.
  useEffect(() => {
    setSelectedExpiry(null);
  }, [id]);

  useEffect(() => {
    load();
    timer.current = window.setInterval(load, REFRESH_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [load]);

  // Re-time the snapshot against the browser clock before anything reads it:
  // the server's day counts freeze between data runs (nights, weekends, a dead
  // token), so without this an expired contract stays in the picker with the
  // DTE it had when the Action last managed to run.
  const timed = useMemo(() => retimeSnapshot(mcx, new Date()), [mcx]);
  const expiries = timed?.expiries ?? null;

  // Selection follows the live list — a contract that expires under a session
  // left open overnight must not stay selected.
  const activeExpiry = useMemo(() => {
    const list = expiries ?? [];
    if (selectedExpiry && list.some((e) => e.optionExpiry === selectedExpiry)) return selectedExpiry;
    return null; // fall back to whatever retimeSnapshot pointed the view at
  }, [expiries, selectedExpiry]);

  // The chosen expiry's contract data swapped into the mcx view. Option cards
  // follow it; the direction engine below stays on the base mcx (global).
  const viewMcx = useMemo(() => mergeExpiry(timed, activeExpiry), [timed, activeExpiry]);

  const scores = useMemo(() => {
    if (!live || !timed) return null;
    return scoreAllHorizons(live, timed); // base mcx → direction is expiry-independent
  }, [live, timed]);

  const regime = useMemo(() => {
    if (!scores || !timed) return null;
    // Hysteresis memory is per metal — silver's last regime must not carry
    // over into gold's badge.
    const prev = cacheGet<Regime>(`regime:${id}`)?.value;
    // Decision horizon keys off the contract being sold — the option DTE.
    const r = deriveRegime(scores, timed.mcx.optionDte ?? timed.mcx.dte, prev);
    cacheSet(`regime:${id}`, r.regime);
    return r;
  }, [scores, timed, id]);

  const premium = useMemo(() => {
    if (!viewMcx) return null;
    return premiumSellScore(viewMcx, viewMcx.events, new Date());
  }, [viewMcx]);

  const derived = useMemo(() => {
    if (!live || !viewMcx) return null;
    const metal = metalForSymbol(viewMcx.mcx.symbol);
    const fv = fairValue(metal, live.metalUsd, live.usdInr);
    return {
      metal,
      fairValue: fv,
      basis: basis(viewMcx.mcx.fut, fv),
      premiumPct: premiumPct(viewMcx.mcx.fut, fv),
      // Gold/silver ratio stays gold-over-silver regardless of which metal is
      // selected, so it reads the same on every screen. Only meaningful when
      // the active metal IS silver; other metals show it as context.
      gsr: live.xauUsd && live.metalUsd ? live.xauUsd / live.metalUsd : null,
    };
  }, [live, viewMcx]);

  const outlook = useMemo(() => {
    if (!live || !viewMcx || !scores || !regime) return null;
    return buildOutlook(live, viewMcx, scores, regime, premium, derived);
  }, [live, viewMcx, scores, regime, premium, derived]);

  // Walk-forward self-check: how often the engine's lean matched what silver
  // actually did. Recomputed only when the snapshot changes.
  const track = useMemo(() => (live ? walkForwardHitRate(live) : null), [live]);

  return {
    live,
    mcx: viewMcx,
    expiries,
    selectedExpiry: viewMcx?.mcx.optionExpiry ?? selectedExpiry,
    setSelectedExpiry,
    scores,
    regime,
    premium,
    outlook,
    track,
    derived,
    loading,
    lastUpdated,
    refresh: load,
  };
}
