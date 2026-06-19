// ---------------------------------------------------------------------------
// Dashboard data hook: fetches live + MCX inputs, computes scores/regime/
// premium, manages refresh interval and regime hysteresis.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  fetchLiveInputs,
  fetchMcxData,
  lastGoodLive,
} from "../lib/fetchers";
import {
  deriveRegime,
  premiumSellScore,
  scoreAllHorizons,
} from "../lib/scoring";
import { basis, fairValueInrPerKg, premiumPct } from "../lib/basis";
import { cacheGet, cacheSet } from "../lib/cache";
import type {
  Horizon,
  HorizonScore,
  LiveInputs,
  McxData,
  PremiumSellScore,
  Regime,
  RegimeResult,
} from "../lib/types";

const REFRESH_MS = 10 * 60 * 1000; // 10 minutes

export interface Dashboard {
  live: LiveInputs | null;
  mcx: McxData | null;
  scores: Record<Horizon, HorizonScore> | null;
  regime: RegimeResult | null;
  premium: PremiumSellScore | null;
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
  const [live, setLive] = useState<LiveInputs | null>(lastGoodLive());
  const [mcx, setMcx] = useState<McxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [liveData, mcxData] = await Promise.all([fetchLiveInputs(), fetchMcxData()]);
    setLive(liveData);
    setMcx(mcxData);
    setLastUpdated(new Date().toISOString());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    timer.current = window.setInterval(load, REFRESH_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [load]);

  const scores = useMemo(() => {
    if (!live || !mcx) return null;
    return scoreAllHorizons(live, mcx);
  }, [live, mcx]);

  const regime = useMemo(() => {
    if (!scores || !mcx) return null;
    const prev = cacheGet<Regime>("regime")?.value;
    const r = deriveRegime(scores, mcx.mcx.dte, prev);
    cacheSet("regime", r.regime);
    return r;
  }, [scores, mcx]);

  const premium = useMemo(() => {
    if (!mcx) return null;
    return premiumSellScore(mcx, mcx.events, new Date());
  }, [mcx]);

  const derived = useMemo(() => {
    if (!live || !mcx) return null;
    const fv = fairValueInrPerKg(live.xagUsd, live.usdInr);
    return {
      fairValue: fv,
      basis: basis(mcx.mcx.silverFut, fv),
      premiumPct: premiumPct(mcx.mcx.silverFut, fv),
      gsr: live.xauUsd && live.xagUsd ? live.xauUsd / live.xagUsd : null,
    };
  }, [live, mcx]);

  return { live, mcx, scores, regime, premium, derived, loading, lastUpdated, refresh: load };
}
