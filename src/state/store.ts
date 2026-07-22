// ---------------------------------------------------------------------------
// Dashboard data hook: loads the server-built snapshot, computes scores/regime/
// premium, manages refresh interval and regime hysteresis.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchSnapshot, fetchLiveSpot } from "../lib/fetchers";
import { deriveRegime, premiumSellScore, scoreAllHorizons } from "../lib/scoring";
import { walkForwardHitRate, type TrackResult } from "../lib/track";
import { buildOutlook, type Outlook } from "../lib/outlook";
import { basis, fairValueInrPerKg, premiumPct } from "../lib/basis";
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
  spot: { xagUsd: number | null; xauUsd: number | null; usdInr: number | null },
): Snapshot {
  const xagUsd = spot.xagUsd ?? snap.live.xagUsd;
  const xauUsd = spot.xauUsd ?? snap.live.xauUsd;
  const usdInr = spot.usdInr ?? snap.live.usdInr;
  const live = {
    ...snap.live,
    xagUsd,
    xauUsd,
    usdInr,
    xagHistory: withLive(snap.live.xagHistory, spot.xagUsd),
    xauHistory: withLive(snap.live.xauHistory, spot.xauUsd),
    usdInrHistory: withLive(snap.live.usdInrHistory, spot.usdInr),
    asOf: new Date().toISOString(),
  };

  const ageMin = (Date.now() - new Date(snap.mcx.asOf).getTime()) / 60000;
  const canImply = spot.xagUsd != null && spot.usdInr != null && snap.mcx.mcx.silverFut != null;
  if (ageMin <= SERVER_STALE_MIN || !canImply) return { live, mcx: snap.mcx };

  // Server MCX is stale — carry the last basis onto live parity for a live price.
  const liveFv = fairValueInrPerKg(xagUsd, usdInr);
  const serverBasis = snap.mcx.basis.basis ?? 0;
  const impliedFut = liveFv != null ? Math.round(liveFv + serverBasis) : snap.mcx.mcx.silverFut;
  const mcx = {
    ...snap.mcx,
    liveParity: true,
    mcx: { ...snap.mcx.mcx, silverFut: impliedFut },
    basis: { fairValue: liveFv != null ? Math.round(liveFv) : snap.mcx.basis.fairValue, basis: serverBasis },
  };
  return { live, mcx };
}

/**
 * Return an mcx view with the chosen expiry's contract data swapped in, so all
 * option cards (chain, IV, GEX, expected move, theta, market structure, basis)
 * re-point to it. The macro direction (scores/regime) is computed from the base
 * mcx, so it stays global. Selecting the nearest keeps the base (live-overlaid).
 */
function mergeExpiry(mcx: McxData | null, sel: string | null): McxData | null {
  const exs = mcx?.expiries;
  if (!mcx || !exs?.length || !sel || sel === mcx.mcx.optionExpiry) return mcx;
  const b = exs.find((e) => e.optionExpiry === sel);
  if (!b) return mcx;
  return {
    ...mcx,
    mcx: {
      ...mcx.mcx,
      silverFut: b.silverFut,
      prevClose: b.prevClose,
      oi: b.oi,
      oiChg: b.oiChg,
      expiry: b.expiry,
      dte: b.dte,
      optionExpiry: b.optionExpiry,
      optionDte: b.optionDte,
    },
    options: {
      ...mcx.options,
      atmStrike: b.atmStrike,
      atmIv: b.atmIv,
      ivEstimated: b.ivEstimated,
      ivRank: b.ivRank,
      ivPercentile: b.ivPercentile,
      ivRankEstimated: b.ivRankEstimated,
      expectedMove1sd: b.expectedMove1sd,
      chain: b.chain,
    },
    gex: b.gex,
    basis: b.basis,
  };
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
    fairValue: number | null;
    basis: number | null;
    premiumPct: number | null;
    gsr: number | null;
  } | null;
  loading: boolean;
  lastUpdated: string | null;
  refresh: () => void;
}

export function useDashboard(): Dashboard {
  const [live, setLive] = useState<LiveInputs | null>(null);
  const [mcx, setMcx] = useState<McxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const snap = await fetchSnapshot();
    if (snap) {
      // Overlay live browser-fetched spot so ⟳ genuinely updates prices even
      // when the server snapshot is stale; falls back to server values if the
      // live fetch is blocked/fails.
      const spot = await fetchLiveSpot().catch(() => null);
      const merged = spot ? applyLiveSpot(snap, spot) : snap;
      setLive(merged.live);
      setMcx(merged.mcx);
      setLastUpdated(spot ? new Date().toISOString() : snap.mcx?.asOf ?? new Date().toISOString());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    timer.current = window.setInterval(load, REFRESH_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [load]);

  // The chosen expiry's contract data swapped into the mcx view. Option cards
  // follow it; the direction engine below stays on the base mcx (global).
  const viewMcx = useMemo(() => mergeExpiry(mcx, selectedExpiry), [mcx, selectedExpiry]);

  const scores = useMemo(() => {
    if (!live || !mcx) return null;
    return scoreAllHorizons(live, mcx); // base mcx → direction is expiry-independent
  }, [live, mcx]);

  const regime = useMemo(() => {
    if (!scores || !mcx) return null;
    const prev = cacheGet<Regime>("regime")?.value;
    // Decision horizon keys off the contract being sold — the option DTE.
    const r = deriveRegime(scores, mcx.mcx.optionDte ?? mcx.mcx.dte, prev);
    cacheSet("regime", r.regime);
    return r;
  }, [scores, mcx]);

  const premium = useMemo(() => {
    if (!viewMcx) return null;
    return premiumSellScore(viewMcx, viewMcx.events, new Date());
  }, [viewMcx]);

  const derived = useMemo(() => {
    if (!live || !viewMcx) return null;
    const fv = fairValueInrPerKg(live.xagUsd, live.usdInr);
    return {
      fairValue: fv,
      basis: basis(viewMcx.mcx.silverFut, fv),
      premiumPct: premiumPct(viewMcx.mcx.silverFut, fv),
      gsr: live.xauUsd && live.xagUsd ? live.xauUsd / live.xagUsd : null,
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
    expiries: mcx?.expiries ?? null,
    selectedExpiry,
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
