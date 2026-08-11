import { useMemo, useState } from "preact/hooks";
import type { McxData, RegimeResult, SellCandidate } from "../lib/types";
import { screenSellCandidates, candidateTone } from "../lib/sellCandidates";
import { contractsFor, lotUnitsFor, metalForSymbol } from "../lib/instrument";
import type { MetalConfig } from "../lib/instrument";
import { fmtOi } from "../lib/chain";
import { Card, Pill, fmt, fmtInt } from "./ui";

const TOP_N = 8;

// Shared by the header and every row so the columns stay locked together.
const GRID =
  "grid grid-cols-[1.9rem_1fr_3rem_1.9rem_2.4rem_2.8rem_2.3rem_2rem] gap-x-1";

const REASON_LABEL: Record<string, string> = {
  noIV: "no solvable IV",
  offSmile: "price off the smile — likely a stale print",
  thinOI: "open interest too thin to trade",
  tinyPrem: "premium too small to be worth the margin",
  tooClose: "inside the gamma zone (< 0.6σ)",
};

export function SellCandidates({
  mcx,
  score,
  regime,
}: {
  mcx: McxData;
  score: number | null;
  regime: RegimeResult | null;
}) {
  const [side, setSide] = useState<"PE" | "CE">("PE");
  const [lotUnits, setLotUnits] = useState<number | null>(null);
  // Which metal's contract specs apply — resolved from the feed's own symbol so
  // the lot multiplier can never come from a different metal than the chain.
  const metal = metalForSymbol(mcx.mcx.symbol);
  const [marginOverride, setMarginOverride] = useState<string>("");
  const [openStrike, setOpenStrike] = useState<number | null>(null);
  const [showRejects, setShowRejects] = useState(false);

  const override = Number(marginOverride);
  const screen = useMemo(
    () =>
      screenSellCandidates(mcx, {
        score,
        regime,
        lotUnits: lotUnits ?? undefined,
        marginOverridePerLot: override > 0 ? override : null,
      }),
    [mcx, score, regime, lotUnits, override],
  );

  const rows = screen.candidates.filter((c) => c.ok && c.type === side);
  const rejects = screen.candidates.filter((c) => !c.ok && c.type === side);
  const dte = mcx.mcx.optionDte ?? mcx.mcx.dte;

  return (
    <Card className="px-2">
      <div className="flex items-center justify-between px-2 mb-2">
        <div className="text-[10px] uppercase tracking-wider text-white/40">Sell candidates</div>
        <div className="flex text-[9px] rounded overflow-hidden border border-white/10">
          <button
            onClick={() => setSide("PE")}
            className={`px-2.5 py-0.5 ${side === "PE" ? "bg-white/10 text-white/80" : "text-white/40"}`}
          >
            PUTS
          </button>
          <button
            onClick={() => setSide("CE")}
            className={`px-2.5 py-0.5 ${side === "CE" ? "bg-white/10 text-white/80" : "text-white/40"}`}
          >
            CALLS
          </button>
        </div>
      </div>

      {!rows.length ? (
        <p className="text-sm text-white/40 px-2 py-6 text-center">
          {screen.candidates.length
            ? `No ${side === "PE" ? "put" : "call"} clears the filters on this expiry — every strike is either inside the gamma zone or too thin. Try a later expiry.`
            : "No option chain for this expiry."}
        </p>
      ) : (
        <>
          <div className={`${GRID} items-end text-[9px] text-white/30 px-2 pb-1`}>
            <span>CONV</span>
            <span>STRIKE</span>
            <span className="text-right">PREM</span>
            <span className="text-right">Δ</span>
            <span className="text-right">P(OTM)</span>
            <span className="text-right">EDGE</span>
            <span className="text-right">TOUCH</span>
            <span className="text-right">OI</span>
          </div>

          <div className="max-h-[58vh] overflow-y-auto">
            {rows.slice(0, TOP_N).map((c) => (
              <Row
                key={`${c.type}-${c.strike}`}
                c={c}
                open={openStrike === c.strike}
                onToggle={() => setOpenStrike(openStrike === c.strike ? null : c.strike)}
              />
            ))}
          </div>
        </>
      )}

      {rejects.length > 0 && (
        <div className="px-2 mt-2 pt-2 border-t border-white/5">
          <button
            onClick={() => setShowRejects(!showRejects)}
            className="text-[10px] text-white/40 active:text-white/70"
          >
            {showRejects ? "▾" : "▸"} {rejects.length} strike{rejects.length > 1 ? "s" : ""} filtered out
          </button>
          {showRejects && (
            <div className="mt-1.5 space-y-1">
              {rejects.map((c) => (
                <div key={c.strike} className="flex items-baseline gap-2 text-[10px]">
                  <span className="tnum text-white/50 w-14">{c.strike.toLocaleString("en-IN")}</span>
                  <span className="text-white/30">
                    {c.reasons.map((r) => REASON_LABEL[r] ?? r).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Controls
        metal={metal}
        lotUnits={lotUnits ?? lotUnitsFor(metal, mcx.mcx.symbol)}
        onLot={setLotUnits}
        marginOverride={marginOverride}
        onMargin={setMarginOverride}
      />

      <div className="px-2 pt-2 mt-1 border-t border-white/5 text-[9px] leading-relaxed text-white/30">
        Prem × lot ({screen.lotUnits}) = credit/lot. <b className="text-white/40">Touch</b> = risk-neutral
        probability of the strike being tested before expiry.{" "}
        <b className="text-white/40">P(OTM)</b> is the <i>forecast</i> probability — our vol estimate{" "}
        {screen.forecastVol != null && `(${(screen.forecastVol * 100).toFixed(1)}%, blended down from IV
        toward realized)`}{" "}
        plus drift{screen.drift ? ` ${(screen.drift * 100).toFixed(1)}%/yr from the ${regime?.dteHorizon ?? ""} score` : " 0"} —
        not the risk-neutral 1−|Δ|. <b className="text-white/40">Edge</b> = premium over that forecast's
        fair value, as a % of margin. Margin is a{" "}
        <span className="text-amber-300/70">modelled SPAN-like estimate</span>, not the exchange's
        number{dte != null && ` · ${dte} DTE`}.
        {screen.confidence < 1 && (
          <span className="text-amber-300/70">
            {" "}Scores shrunk ×{screen.confidence.toFixed(2)} — the IV or the snapshot behind them is
            proxied or stale.
          </span>
        )}{" "}
        CONV weights are hand-set priors, not backtested.
      </div>
    </Card>
  );
}

function Row({ c, open, onToggle }: { c: SellCandidate; open: boolean; onToggle: () => void }) {
  const tone = candidateTone(c);
  const convColor =
    c.conv >= 70 ? "text-emerald-300" : c.conv >= 45 ? "text-sky-300" : "text-white/50";
  const toneColor =
    tone === "bull" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-rose-300";
  const edgeColor = c.edgePct > 0 ? "text-emerald-300" : "text-rose-300";

  return (
    <div className={`rounded ${open ? "bg-white/[0.04]" : ""}`}>
      <button
        onClick={onToggle}
        className={`w-full ${GRID} items-center px-2 py-1.5 text-left`}
      >
        <span className={`text-base font-bold tnum leading-none ${convColor}`}>{c.conv}</span>
        <span className="min-w-0 leading-tight">
          <span className="block text-sm font-semibold tnum text-white/85 truncate">
            {c.strike.toLocaleString("en-IN")}
          </span>
          <span className="block text-[8px] tnum text-white/35">
            {c.cushion.toFixed(1)}σ
            {c.thin && <span className="ml-1 uppercase text-amber-300/60">thin</span>}
          </span>
        </span>
        <span className="text-right leading-tight">
          <span className="block text-[11px] tnum text-white/80">{fmt(c.premium, 1)}</span>
          <span className="block text-[8px] tnum text-white/35">₹{fmtInt(c.credit)}</span>
        </span>
        <span className="text-right text-[10px] tnum text-white/50">
          {Math.abs(c.delta).toFixed(2)}
        </span>
        <span className={`text-right text-[11px] tnum ${toneColor}`}>
          {(c.pOtm * 100).toFixed(0)}%
        </span>
        <span className={`text-right text-[10px] tnum ${edgeColor}`}>
          {c.edgePct > 0 ? "+" : ""}
          {c.edgePct.toFixed(1)}%
        </span>
        <span className="text-right text-[10px] tnum text-white/50">
          {(c.touch * 100).toFixed(0)}%
        </span>
        <span className="text-right text-[10px] tnum text-white/40">{fmtOi(c.oi)}</span>
      </button>

      {open && (
        <div className="px-2 pb-2.5 -mt-0.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            <Detail label="Credit / lot" value={`₹${fmtInt(c.credit)}`} />
            <Detail
              label={c.marginModelled ? "Margin / lot (est.)" : "Margin / lot"}
              value={`₹${fmtInt(c.marginPerLot)}`}
            />
            <Detail label="Return on margin" value={`${c.romAnnual.toFixed(0)}% ann.`} />
            <Detail label="Breakeven" value={fmtInt(c.breakeven)} />
            <Detail label="Strike IV" value={`${(c.iv * 100).toFixed(1)}%`} />
            <Detail label="Tail loss (worst 5%)" value={`${c.tailPct.toFixed(0)}% of margin`} />
            <Detail label="Fair value (forecast)" value={fmt(c.fair, 1)} />
            <Detail label="Edge" value={`${fmt(c.edge, 1)} ₹/kg`} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Pill tone={tone}>
              {tone === "bull" ? "SAFE" : tone === "warn" ? "WATCH" : "TIGHT"}
            </Pill>
            {c.withRegime === true && <Pill tone="bull">with regime</Pill>}
            {c.withRegime === false && <Pill tone="warn">against regime</Pill>}
            {c.thin && <Pill tone="warn">thin book — size down</Pill>}
          </div>
          <p className="mt-2 text-[10px] leading-snug text-white/50">
            Sell {c.strike.toLocaleString("en-IN")} {c.type} for {fmt(c.premium, 1)} (₹
            {fmtInt(c.credit)}/lot). It sits {c.cushion.toFixed(1)}σ away; on our forecast it expires
            worthless {(c.pOtm * 100).toFixed(0)}% of the time, but gets tested{" "}
            {(c.touch * 100).toFixed(0)}% of the time before that. The 1-in-20 bad case costs{" "}
            {c.tailPct.toFixed(0)}% of the margin it ties up.
          </p>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-white/35">{label}</span>
      <span className="tnum text-white/70">{value}</span>
    </div>
  );
}

function Controls({
  metal,
  lotUnits,
  onLot,
  marginOverride,
  onMargin,
}: {
  metal: MetalConfig;
  lotUnits: number;
  onLot: (units: number) => void;
  marginOverride: string;
  onMargin: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pt-2 mt-2 border-t border-white/5">
      <label className="text-[9px] uppercase tracking-wide text-white/30">Contract</label>
      <select
        value={String(lotUnits)}
        onChange={(e) => onLot(Number((e.target as HTMLSelectElement).value))}
        className="bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white/70"
      >
        {contractsFor(metal).map(({ symbol, label }) => (
          <option key={symbol} value={String(lotUnitsFor(metal, symbol))}>
            {label}
          </option>
        ))}
      </select>
      <label className="text-[9px] uppercase tracking-wide text-white/30 ml-auto">Margin ₹/lot</label>
      <input
        type="number"
        inputMode="numeric"
        placeholder="est."
        value={marginOverride}
        onInput={(e) => onMargin((e.target as HTMLInputElement).value)}
        className="w-20 bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[10px] tnum text-white/70 placeholder:text-white/25"
      />
    </div>
  );
}
