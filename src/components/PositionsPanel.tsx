import { useMemo, useState } from "preact/hooks";
import type { McxData } from "../lib/types";
import {
  black76Price,
  cushionSigma,
  probabilityAbove,
  probabilityBelow,
  probabilityOfTouch,
} from "../lib/options";
import { cacheGet, cacheSet } from "../lib/cache";
import { Card, SectionTitle, Pill, fmtInt } from "./ui";

/** A sold option the user is carrying. Premium is in ₹/kg (MCX quote units). */
export interface SoldPosition {
  id: string;
  type: "CE" | "PE";
  strike: number;
  premium: number; // ₹/kg received
  lots: number;
  lotKg: number; // 1 = SILVERMIC, 5 = SILVERM, 30 = SILVER
  openedAt: string; // ISO date
}

const STORE_KEY = "positions";
const loadPositions = (): SoldPosition[] => cacheGet<SoldPosition[]>(STORE_KEY)?.value ?? [];

type Status = { label: string; tone: "bull" | "warn" | "bear" };
function statusOf(probItm: number, cushion: number, captured: number | null): Status {
  if (probItm > 0.3 || cushion < 0.75) return { label: "DANGER", tone: "bear" };
  if (probItm > 0.15 || cushion < 1.25) return { label: "WATCH", tone: "warn" };
  if (captured != null && captured >= 70) return { label: "BOOK?", tone: "bull" };
  return { label: "SAFE", tone: "bull" };
}

export function PositionsPanel({ mcx }: { mcx: McxData }) {
  const [positions, setPositions] = useState<SoldPosition[]>(loadPositions);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ type: "CE" as "CE" | "PE", strike: "", premium: "", lots: "1", lotKg: "5" });

  const F = mcx.mcx.silverFut;
  const dte = mcx.mcx.optionDte ?? mcx.mcx.dte;
  const t = dte != null && dte > 0 ? dte / 365 : null;
  const atmIv = mcx.options.atmIv;
  const chain = mcx.options.chain ?? [];

  const save = (next: SoldPosition[]) => {
    setPositions(next);
    cacheSet(STORE_KEY, next);
  };

  const addPosition = () => {
    const strike = Number(form.strike);
    const premium = Number(form.premium);
    const lots = Math.max(1, Math.round(Number(form.lots) || 1));
    const lotKg = Number(form.lotKg) || 5;
    if (!(strike > 0) || !(premium > 0)) return;
    save([
      ...positions,
      {
        id: `${Date.now()}`,
        type: form.type,
        strike,
        premium,
        lots,
        lotKg,
        openedAt: new Date().toISOString().slice(0, 10),
      },
    ]);
    setForm({ ...form, strike: "", premium: "" });
    setAdding(false);
  };

  /** IV for a strike: nearest same-type quote from the live chain, else ATM IV. */
  const ivFor = (type: "CE" | "PE", strike: number): number | null => {
    const same = chain.filter((o) => o.type === type && o.iv != null);
    if (same.length) {
      const nearest = same.reduce((b, o) => (Math.abs(o.strike - strike) < Math.abs(b.strike - strike) ? o : b));
      if (Math.abs(nearest.strike - strike) <= strike * 0.06) return nearest.iv;
    }
    return atmIv;
  };

  const rows = useMemo(() => {
    if (F == null || t == null) return [];
    return positions.map((p) => {
      const iv = ivFor(p.type, p.strike);
      if (iv == null) return { p, ok: false as const };
      const theo = black76Price(F, p.strike, t, iv, p.type);
      const pnlPerKg = p.premium - theo;
      const pnl = pnlPerKg * p.lotKg * p.lots;
      const captured = p.premium > 0 ? (pnlPerKg / p.premium) * 100 : null;
      const probItm = p.type === "CE" ? probabilityAbove(F, p.strike, iv, t) : probabilityBelow(F, p.strike, iv, t);
      const touch = probabilityOfTouch(F, p.strike, iv, t);
      const cushion = cushionSigma(F, p.strike, iv, t);
      const breakeven = p.type === "CE" ? p.strike + p.premium : p.strike - p.premium;
      return { p, ok: true as const, iv, theo, pnl, captured, probItm, touch, cushion, breakeven, status: statusOf(probItm, cushion, captured) };
    });
  }, [positions, F, t, atmIv, chain]);

  const totalPnl = rows.reduce((a, r) => a + (r.ok ? r.pnl : 0), 0);
  const worst = rows.filter((r) => r.ok).sort((a, b) => (b as any).probItm - (a as any).probItm)[0];

  return (
    <Card>
      <div className="flex items-center justify-between">
        <SectionTitle>My sold positions</SectionTitle>
        {rows.length > 0 && (
          <span className={`text-sm font-bold tnum ${totalPnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {totalPnl >= 0 ? "+" : "−"}₹{fmtInt(Math.abs(totalPnl))}
          </span>
        )}
      </div>

      {positions.length === 0 && !adding && (
        <p className="text-xs text-white/45 leading-snug">
          Track the options you've sold: live P&L, breach odds and a SAFE / WATCH / DANGER read per
          strike — priced with the live IV, not guesses.
        </p>
      )}

      <div className="space-y-2 mt-1">
        {rows.map((r) =>
          r.ok ? (
            <div key={r.p.id} className="rounded-xl bg-black/25 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white/90">
                  {r.p.type === "CE" ? "Sold CALL" : "Sold PUT"} <span className="tnum">{fmtInt(r.p.strike)}</span>
                  <span className="text-white/40 text-[10px] font-normal ml-1.5">
                    {r.p.lots}×{r.p.lotKg}kg · prem {fmtInt(r.p.premium)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Pill tone={r.status.tone}>{r.status.label}</Pill>
                  <button onClick={() => save(positions.filter((x) => x.id !== r.p.id))} className="text-white/30 hover:text-rose-300 text-sm px-1" title="remove">
                    ✕
                  </button>
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-y-1 text-[11px]">
                <Cell l="P&L" v={`${r.pnl >= 0 ? "+" : "−"}₹${fmtInt(Math.abs(r.pnl))}`} tone={r.pnl >= 0 ? "up" : "down"} />
                <Cell l="captured" v={r.captured == null ? "—" : `${Math.round(r.captured)}%`} />
                <Cell l="theo now" v={`₹${fmtInt(r.theo)}`} />
                <Cell l="breach @ expiry" v={`${(r.probItm * 100).toFixed(1)}%`} tone={r.probItm > 0.25 ? "down" : r.probItm > 0.12 ? "warn" : "up"} />
                <Cell l="touched before" v={`${Math.round(r.touch * 100)}%`} />
                <Cell l="cushion" v={`${r.cushion.toFixed(2)}σ`} />
              </div>
              <div className="mt-1 text-[10px] text-white/35">
                breakeven {fmtInt(r.breakeven)} · IV {(r.iv! * 100).toFixed(0)}% · since {r.p.openedAt}
              </div>
            </div>
          ) : (
            <div key={r.p.id} className="rounded-xl bg-black/25 px-3 py-2 text-xs text-white/40">
              {r.p.type} {fmtInt(r.p.strike)} — waiting on live price/IV to analyze.
            </div>
          ),
        )}
      </div>

      {worst && worst.ok && rows.length > 1 && (
        <p className="text-[10px] text-amber-300/70 mt-2">
          Most at risk: {worst.p.type} {fmtInt(worst.p.strike)} ({(worst.probItm * 100).toFixed(0)}% breach odds).
        </p>
      )}

      {adding ? (
        <div className="mt-3 rounded-xl bg-white/5 p-3 space-y-2">
          <div className="flex gap-2">
            {(["CE", "PE"] as const).map((ty) => (
              <button
                key={ty}
                onClick={() => setForm({ ...form, type: ty })}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold border ${
                  form.type === ty
                    ? ty === "CE" ? "bg-rose-500/20 border-rose-400/40 text-rose-200" : "bg-emerald-500/20 border-emerald-400/40 text-emerald-200"
                    : "bg-black/20 border-white/10 text-white/50"
                }`}
              >
                Sold {ty === "CE" ? "CALL" : "PUT"}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Strike (₹/kg)" value={form.strike} onInput={(v) => setForm({ ...form, strike: v })} placeholder={F ? String(Math.round((F * (form.type === "CE" ? 1.06 : 0.94)) / 500) * 500) : ""} />
            <Field label="Premium received (₹/kg)" value={form.premium} onInput={(v) => setForm({ ...form, premium: v })} placeholder="e.g. 2500" />
            <Field label="Lots" value={form.lots} onInput={(v) => setForm({ ...form, lots: v })} />
            <label className="text-[10px] uppercase text-white/40">
              Contract
              <select
                value={form.lotKg}
                onChange={(e) => setForm({ ...form, lotKg: (e.target as HTMLSelectElement).value })}
                className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
              >
                <option value="30">SILVER (30 kg)</option>
                <option value="5">SILVERM (5 kg)</option>
                <option value="1">SILVERMIC (1 kg)</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={addPosition} className="flex-1 rounded-lg bg-sky-500/25 border border-sky-400/40 text-sky-200 py-1.5 text-xs font-semibold">
              Add position
            </button>
            <button onClick={() => setAdding(false)} className="rounded-lg bg-black/20 border border-white/10 text-white/50 px-4 py-1.5 text-xs">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-2 w-full rounded-xl border border-dashed border-white/15 py-2 text-xs text-white/50 hover:text-white/80 hover:border-white/30">
          + add a sold option
        </button>
      )}

      {rows.length > 0 && (
        <p className="text-[10px] text-white/30 mt-2">
          Theo value = Black-76 at live IV ({dte ?? "—"} DTE). "Breach" = finishing ITM at expiry; P&L
          excludes brokerage. Stored only on this device.
        </p>
      )}
    </Card>
  );
}

function Cell({ l, v, tone }: { l: string; v: string; tone?: "up" | "down" | "warn" }) {
  const c = tone === "up" ? "text-emerald-300" : tone === "down" ? "text-rose-300" : tone === "warn" ? "text-amber-300" : "text-white/80";
  return (
    <span>
      <span className="text-white/40">{l}: </span>
      <span className={`tnum font-semibold ${c}`}>{v}</span>
    </span>
  );
}

function Field({ label, value, onInput, placeholder }: { label: string; value: string; onInput: (v: string) => void; placeholder?: string }) {
  return (
    <label className="text-[10px] uppercase text-white/40">
      {label}
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm tnum text-white"
      />
    </label>
  );
}
