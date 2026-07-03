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

/** A sold option the user is carrying. Prices are in ₹/kg (MCX quote units). */
export interface SoldPosition {
  id: string;
  type: "CE" | "PE";
  strike: number;
  premium: number; // the price the option was SOLD at, ₹/kg
  lots: number;
  lotKg: number; // 1 = SILVERMIC, 5 = SILVERM, 30 = SILVER
  expiry: string; // ISO date of the option expiry
  openedAt: string; // ISO date
  manualCmp?: number | null; // user-entered current option price (₹/kg)
  manualCmpAt?: string | null; // ISO date the CMP was entered
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

/** Month-end weekday fallback expiries when no live list is available. */
function genExpiries(n = 4): string[] {
  const out: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  for (let k = 0; k < n; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k + 1, 0));
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    if (iso >= today) out.push(iso);
  }
  return out;
}

const expiryLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });

export function PositionsPanel({ mcx }: { mcx: McxData }) {
  const [positions, setPositions] = useState<SoldPosition[]>(loadPositions);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const F = mcx.mcx.silverFut;
  const atmIv = mcx.options.atmIv;
  const chain = mcx.options.chain ?? [];

  // Available option expiries: live list, else the front expiry, else generated.
  const expiries = useMemo(() => {
    const live = (mcx.mcx.optionExpiries ?? []).filter(Boolean);
    if (live.length) return live;
    const front = mcx.mcx.optionExpiry ?? mcx.mcx.expiry;
    const gen = genExpiries();
    return front ? [front, ...gen.filter((d) => d !== front)] : gen;
  }, [mcx.mcx.optionExpiries, mcx.mcx.optionExpiry, mcx.mcx.expiry]);

  const [form, setForm] = useState({
    type: "CE" as "CE" | "PE",
    strike: "",
    premium: "",
    cmp: "",
    lots: "1",
    lotKg: "5",
    expiry: expiries[0] ?? "",
  });
  const [cmpEdit, setCmpEdit] = useState<{ id: string; value: string } | null>(null);

  const save = (next: SoldPosition[]) => {
    setPositions(next);
    cacheSet(STORE_KEY, next);
  };

  const addPosition = () => {
    const strike = Number(form.strike);
    const premium = Number(form.premium);
    const cmp = Number(form.cmp);
    const expiry = form.expiry || expiries[0];
    if (!(strike > 0)) return setError("Enter the strike you sold.");
    if (!(premium > 0)) return setError("Enter the price you SOLD the option at (₹/kg) — e.g. 2500.");
    if (!expiry) return setError("Pick an expiry month.");
    const lots = Math.max(1, Math.round(Number(form.lots) || 1));
    const lotKg = Number(form.lotKg) || 5;
    const today = new Date().toISOString().slice(0, 10);
    save([
      ...positions,
      {
        id: `${Date.now()}`, type: form.type, strike, premium, lots, lotKg, expiry, openedAt: today,
        manualCmp: cmp > 0 ? cmp : null,
        manualCmpAt: cmp > 0 ? today : null,
      },
    ]);
    setForm({ ...form, strike: "", premium: "", cmp: "" });
    setError("");
    setAdding(false);
  };

  const setCmp = (id: string, raw: string) => {
    const v = Number(raw);
    const today = new Date().toISOString().slice(0, 10);
    save(positions.map((p) => (p.id === id ? { ...p, manualCmp: v > 0 ? v : null, manualCmpAt: v > 0 ? today : null } : p)));
    setCmpEdit(null);
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
    if (F == null) return [];
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    return positions.map((p) => {
      const expiry = p.expiry ?? mcx.mcx.optionExpiry ?? mcx.mcx.expiry ?? null;
      const dte = expiry ? Math.max(0, Math.ceil((new Date(expiry).getTime() - now) / 86400000)) : (mcx.mcx.optionDte ?? null);
      const t = dte != null && dte > 0 ? dte / 365 : null;
      const iv = ivFor(p.type, p.strike);
      if (iv == null || t == null) return { p, ok: false as const, expiry, dte };

      // Current option price, best source first:
      //  1) live exchange quote for this exact strike/type (auto-refreshes),
      //  2) the CMP the user typed (dated, may be stale),
      //  3) Black-76 model estimate.
      const liveQuote = chain.find((o) => o.type === p.type && Math.abs(o.strike - p.strike) < 1 && o.ltp > 0);
      const theo = black76Price(F, p.strike, t, iv, p.type);
      let current: number;
      let source: string;
      if (liveQuote) {
        current = liveQuote.ltp;
        source = "live mkt";
      } else if (p.manualCmp != null && p.manualCmp > 0) {
        current = p.manualCmp;
        source = p.manualCmpAt === today ? "your CMP" : `your CMP (${p.manualCmpAt})`;
      } else {
        current = theo;
        source = "model est.";
      }

      const pnlPerKg = p.premium - current;
      const pnl = pnlPerKg * p.lotKg * p.lots;
      const captured = p.premium > 0 ? (pnlPerKg / p.premium) * 100 : null;
      const probItm = p.type === "CE" ? probabilityAbove(F, p.strike, iv, t) : probabilityBelow(F, p.strike, iv, t);
      const touch = probabilityOfTouch(F, p.strike, iv, t);
      const cushion = cushionSigma(F, p.strike, iv, t);
      const breakeven = p.type === "CE" ? p.strike + p.premium : p.strike - p.premium;
      return { p, ok: true as const, iv, current, source, pnl, captured, probItm, touch, cushion, breakeven, expiry, dte, status: statusOf(probItm, cushion, captured) };
    });
  }, [positions, F, atmIv, chain, mcx.mcx.optionExpiry, mcx.mcx.optionDte]);

  const totalPnl = rows.reduce((a, r) => a + (r.ok ? r.pnl : 0), 0);
  const worst = rows.filter((r): r is Extract<typeof r, { ok: true }> => r.ok).sort((a, b) => b.probItm - a.probItm)[0];

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
                <Cell l={`now (${r.source})`} v={`₹${fmtInt(r.current)}`} />
                <Cell l="breach @ expiry" v={`${(r.probItm * 100).toFixed(1)}%`} tone={r.probItm > 0.25 ? "down" : r.probItm > 0.12 ? "warn" : "up"} />
                <Cell l="touched before" v={`${Math.round(r.touch * 100)}%`} />
                <Cell l="cushion" v={`${r.cushion.toFixed(2)}σ`} />
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-white/35">
                <span>
                  breakeven {fmtInt(r.breakeven)} · IV {(r.iv! * 100).toFixed(0)}% · exp {r.expiry ? expiryLabel(r.expiry) : "—"} ({r.dte ?? "—"}d)
                </span>
                {cmpEdit?.id === r.p.id ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="number"
                      value={cmpEdit.value}
                      placeholder="option CMP"
                      onInput={(e) => setCmpEdit({ id: r.p.id, value: (e.target as HTMLInputElement).value })}
                      className="w-20 rounded bg-black/40 border border-white/15 px-1.5 py-0.5 text-[11px] tnum text-white"
                    />
                    <button onClick={() => setCmp(r.p.id, cmpEdit.value)} className="text-sky-300 font-semibold">save</button>
                  </span>
                ) : (
                  <button onClick={() => setCmpEdit({ id: r.p.id, value: r.p.manualCmp ? String(r.p.manualCmp) : "" })} className="text-sky-300/70 hover:text-sky-200">
                    upd CMP
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div key={r.p.id} className="rounded-xl bg-black/25 px-3 py-2 text-xs text-white/40">
              {r.p.type} {fmtInt(r.p.strike)} — waiting on live price/IV to analyze.
            </div>
          ),
        )}
      </div>

      {worst && rows.length > 1 && (
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
            <Field label="Sold at (option price) *" value={form.premium} onInput={(v) => setForm({ ...form, premium: v })} placeholder="e.g. 2500" />
            <Field label="Option CMP now (optional)" value={form.cmp} onInput={(v) => setForm({ ...form, cmp: v })} placeholder="today's price" />
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
            <label className="text-[10px] uppercase text-white/40 col-span-2">
              Expiry month
              <select
                value={form.expiry}
                onChange={(e) => setForm({ ...form, expiry: (e.target as HTMLSelectElement).value })}
                className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
              >
                {expiries.map((d) => (
                  <option key={d} value={d}>{expiryLabel(d)} ({d})</option>
                ))}
              </select>
            </label>
          </div>
          {error && <p className="text-[11px] text-rose-300">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={addPosition} className="flex-1 rounded-lg bg-sky-500/25 border border-sky-400/40 text-sky-200 py-1.5 text-xs font-semibold">
              Add position
            </button>
            <button onClick={() => { setAdding(false); setError(""); }} className="rounded-lg bg-black/20 border border-white/10 text-white/50 px-4 py-1.5 text-xs">
              Cancel
            </button>
          </div>
          <p className="text-[10px] text-white/30">
            * "Sold at" = the option's price when you sold it (that price IS your premium, in ₹/kg).
            CMP is optional — if the strike is quoted live we use the exchange price automatically.
          </p>
        </div>
      ) : (
        <button onClick={() => { setError(""); setForm({ ...form, expiry: expiries[0] ?? form.expiry }); setAdding(true); }} className="mt-2 w-full rounded-xl border border-dashed border-white/15 py-2 text-xs text-white/50 hover:text-white/80 hover:border-white/30">
          + add a sold option
        </button>
      )}

      {rows.length > 0 && (
        <p className="text-[10px] text-white/30 mt-2">
          P&L = (sold at − current) × kg. Current price source shown per row: live mkt (exchange quote)
          → your CMP → model est. Breach/touch odds from Black-76 at live IV. Excludes brokerage/taxes.
          Stored only on this device.
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
