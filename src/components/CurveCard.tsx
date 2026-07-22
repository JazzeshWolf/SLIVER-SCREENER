import type { McxData } from "../lib/types";
import { Card, SectionTitle, Pill, Implication, fmt, pct } from "./ui";

/**
 * COMEX silver futures term structure — contango vs backwardation.
 * OpenBB-style curve read (Yahoo/CME), the one international signal OpenBB is
 * good at that we lacked. Silver normally sits in mild contango (carry); a flip
 * toward backwardation flags physical tightness / squeeze risk for short calls.
 */
export function CurveCard({ mcx }: { mcx: McxData }) {
  const c = mcx.curve;
  if (!c) return null; // no futures data → hide entirely (never fake it)

  const back = c.structure === "backwardation";
  const flat = c.structure === "flat";
  const tone: "bull" | "neutral" | "warn" = back ? "warn" : flat ? "warn" : "neutral";
  const label = back ? "Backwardation" : flat ? "Flat / tight" : "Contango";

  const impl = back
    ? "Near months trading ABOVE far months — physical tightness. Historically bullish and squeeze fuel: a real warning for short calls. Favour selling puts with cushion over selling calls."
    : flat
      ? "The curve is nearly flat — carry has compressed toward tightness. Not an alert yet, but watch for a slide into backwardation, which would tilt risk against short calls."
      : "Normal contango — far months above near (cost of carry). No tightness signal; the curve isn't flashing squeeze risk. Neutral for an options seller.";

  return (
    <Card>
      <SectionTitle>Silver futures curve (COMEX)</SectionTitle>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-2xl font-bold tnum">${fmt(c.front)}</div>
          <div className="text-[10px] text-white/40 mt-0.5">
            nearest contract · annualized {pct(c.annualizedPct)}
          </div>
        </div>
        <Pill tone={tone}>{label}</Pill>
      </div>

      <div className="mt-3 flex items-end gap-1.5">
        {(() => {
          const lo = Math.min(...c.months.map((x) => x.price));
          const hi = Math.max(...c.months.map((x) => x.price));
          return c.months.map((m) => {
          const h = hi > lo ? 14 + ((m.price - lo) / (hi - lo)) * 26 : 26; // 14–40px bars
          return (
            <div key={m.label} className="flex-1 flex flex-col items-center gap-1">
              <div className="tnum text-[9px] text-white/50">{fmt(m.price)}</div>
              <div
                className={`w-full rounded-sm ${back ? "bg-amber-400/50" : "bg-sky-400/40"}`}
                style={{ height: `${h}px` }}
              />
              <div className="text-[9px] text-white/40">{m.label}</div>
            </div>
          );
          });
        })()}
      </div>

      <Implication tone={tone}>{impl}</Implication>
      <p className="text-[10px] text-white/30 mt-2">
        COMEX (international) silver, not MCX — a structural backdrop, not a day-trade timing tool.
        {c.source === "carry" && " Only the front contract was available, so this is a front-vs-spot carry approximation."}
      </p>
    </Card>
  );
}
