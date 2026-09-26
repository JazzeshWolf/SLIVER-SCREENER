// ---------------------------------------------------------------------------
// "What's happening right now" for each factor in the breakdown card.
//
// The card used to say only "Currently leaning bearish." This spells out the
// live numbers behind a factor's reading, from the SAME inputs and windows the
// engine scored (scoring.ts), e.g.:
//
//   "CRUDEOILM futures fell 3.5% on the day (₹9,161 → ₹8,843) while open
//    interest fell by 4,202 contracts. Long unwinding: holders are exiting
//    rather than new sellers arriving — bearish, though selling like this can
//    run out of steam."
//
// Display only. Nothing here feeds a score.
// ---------------------------------------------------------------------------

import type { FactorContribution, Horizon, LiveInputs, McxData, Point } from "./types";
import type { MetalConfig } from "./metals.mjs";
import { changeOverWindow, mean, tail, vsMovingAverage, vsMovingAverageSeries } from "./stats";
import { factorWindow, TERM_STRUCTURE_FULL_PCT } from "./scoring";
import { curveRead } from "./curveRead";

const rupees = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const num = (v: number, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pctAbs = (x: number) => `${Math.abs(x * 100).toFixed(1)}%`;
const pctSigned = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
/** An international price in the metal's own unit, e.g. "$92.33". */
const intl = (v: number) => `$${num(v, v >= 1000 ? 0 : 2)}`;
const sessions = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

/** How the engine scored it, in words — the tail of every story. */
export function readsAs(f: FactorContribution): string {
  const word = f.s > 0.05 ? "bullish" : f.s < -0.05 ? "bearish" : "neutral";
  return `Reads ${word} (${f.s >= 0 ? "+" : ""}${f.s.toFixed(2)}).`;
}

/** Position of the latest point against its trailing `window` average. */
function vsAverage(points: Point[], window: number) {
  const v = vsMovingAverage(points, window);
  if (v === null) return null;
  return { gap: v, last: points[points.length - 1].v, avg: mean(tail(points, window)) };
}

/**
 * Momentum in words. The engine does not score the raw gap to the average: it
 * scores the gap against the metal's OWN recent gaps (a z-score), so a price
 * above its average can still read bearish if it was further above lately.
 * Say so, or the card contradicts its own number.
 */
function momentumWords(subject: string, points: Point[], window: number, f: FactorContribution, note = ""): string | null {
  const m = vsAverage(points, window);
  if (!m) return null;
  const side = m.gap >= 0 ? "above" : "below";
  const head = `${subject} is ${pctAbs(m.gap)} ${side} its ${window}-day average (${intl(m.last)} vs ${intl(m.avg)})`;
  const series = vsMovingAverageSeries(points, window);
  const tailText = `${note ? `${note} ` : ""}${readsAs(f)}`;
  if (series.length < 10) return `${head}. ${tailText}`;
  const typical = mean(series);
  const typ = `${typical >= 0 ? "+" : "−"}${pctAbs(typical)}`;
  if (m.gap >= 0 && f.s < -0.05) {
    return `${head} — but that is less stretched than its typical ${typ} gap over this stretch, so the rise is losing steam. ${tailText}`;
  }
  if (m.gap < 0 && f.s > 0.05) {
    return `${head} — but that is less stretched than its typical ${typ} gap over this stretch, so it is recovering. ${tailText}`;
  }
  return `${head}, against a typical ${typ} gap over this stretch. ${tailText}`;
}

/** Change over the last `window` points, with both ends. */
function over(points: Point[], window: number) {
  const ch = changeOverWindow(points, window);
  if (ch === null) return null;
  return { ch, from: points[points.length - 1 - window].v, to: points[points.length - 1].v };
}

/** a/b now vs its trailing average, aligned from the ends the way ratioZ is. */
function ratioVsAverage(a: Point[], b: Point[], window: number) {
  if (a.length < window || b.length < window) return null;
  const n = Math.min(a.length, b.length);
  const r: number[] = [];
  for (let i = n - window; i < n; i++) {
    const x = a[a.length - n + i]?.v;
    const y = b[b.length - n + i]?.v;
    if (x && y && y > 0) r.push(x / y);
  }
  if (r.length < 5) return null;
  const avg = mean(r);
  const now = r[r.length - 1];
  return { now, avg, gap: (now - avg) / avg };
}

/**
 * The live story behind one factor's reading, or null when there is nothing
 * more specific to say than the static description.
 */
export function factorStory(
  f: FactorContribution,
  horizon: Horizon,
  live: LiveInputs,
  mcx: McxData,
  metal: MetalConfig,
): string | null {
  const name = metal.label.toLowerCase();
  const w = factorWindow(f.key, horizon);

  if (!f.present) {
    const shared = "so its weight is shared out among the other factors until then.";
    if (f.key === "longTrend") {
      return `Needs at least 100 days of ${name} price history — there are ${live.metalHistory.length} so far, ${shared}`;
    }
    if (f.key === "gsr" || f.key === "gsrGold" || f.key === "copperGold") {
      const have = Math.min(live.metalHistory.length, live.xauHistory.length);
      return `Needs ${w} days of history for the ${horizon} reading — there are ${have} so far, ${shared}`;
    }
    return null;
  }

  switch (f.key) {
    case "mcxPositioning": {
      const { fut, prevClose, oiChg, symbol } = mcx.mcx;
      if (fut == null || prevClose == null || oiChg == null || !prevClose) return null;
      const ch = (fut - prevClose) / prevClose;
      const dir = fut > prevClose ? "rose" : fut < prevClose ? "fell" : "was flat";
      const move = `${symbol} futures ${dir}${fut !== prevClose ? ` ${pctAbs(ch)}` : ""} on the day (${rupees(prevClose)} → ${rupees(fut)})`;
      const oi = oiChg === 0 ? "open interest was unchanged" : `open interest ${oiChg > 0 ? "rose" : "fell"} by ${Math.abs(oiChg).toLocaleString("en-IN")} contracts`;
      let what: string;
      if (fut > prevClose) {
        what = oiChg > 0
          ? "Fresh buying: new longs are backing the rise — bullish."
          : "Short covering: shorts are buying back rather than new buyers arriving — mildly bullish, but covering rallies often fade.";
      } else if (fut < prevClose) {
        what = oiChg < 0
          ? "Long unwinding: holders are exiting rather than new sellers arriving — bearish, though selling like this can run out of steam."
          : "Fresh selling: new shorts are pressing the fall — bearish.";
      } else {
        what = "No price move, so no directional read from positioning.";
      }
      return `${move} while ${oi}. ${what} (A 4% day moves this factor all the way.) ${readsAs(f)}`;
    }

    case "metalMomo":
      return momentumWords(metal.label, live.metalHistory, w, f);

    case "longTrend": {
      const n = Math.min(w, live.metalHistory.length);
      const m = vsAverage(live.metalHistory, n);
      if (!m) return null;
      return `${metal.label} is ${pctAbs(m.gap)} ${m.gap >= 0 ? "above" : "below"} its ${n}-day average (${intl(m.last)} vs ${intl(m.avg)}) — the long trend is ${m.gap >= 0 ? "up" : "down"}. ${readsAs(f)}`;
    }

    case "goldMomo":
      return momentumWords("Gold", live.xauHistory, w, f, `${metal.label} tends to follow gold.`);

    case "dxy": {
      const o = over(live.dxyHistory, w);
      if (!o) return null;
      const idx = live.usdBroad ? "The dollar (Fed broad index)" : "The dollar index";
      if (Math.abs(o.ch) < 0.0005) {
        return `${idx} is flat over the last ${sessions(w)} (${num(o.from)} → ${num(o.to)}) — no push on ${name} either way. ${readsAs(f)}`;
      }
      return `${idx} ${o.ch >= 0 ? "rose" : "fell"} ${pctAbs(o.ch)} over the last ${sessions(w)} (${num(o.from)} → ${num(o.to)}) — a ${o.ch >= 0 ? "firmer dollar weighs on" : "softer dollar supports"} ${name}. Scored against the dollar's usual ${w}-session moves. ${readsAs(f)}`;
    }

    case "real10y": {
      const o = over(live.real10yHistory, w);
      if (!o) return null;
      return `The 10-year real yield went from ${num(o.from)}% to ${num(o.to)}% over the last ${sessions(w)} — ${o.to >= o.from ? "rising real yields weigh on" : "falling real yields support"} ${name}. ${readsAs(f)}`;
    }

    case "usdInr": {
      const o = over(live.usdInrHistory, w);
      if (!o) return null;
      return `USD-INR went from ${num(o.from)} to ${num(o.to)} over the last ${sessions(w)} (${pctSigned(o.ch)}) — a ${o.ch >= 0 ? "weaker rupee lifts" : "stronger rupee lowers"} the MCX price in rupees, whatever the international price does. ${readsAs(f)}`;
    }

    case "gsr":
    case "gsrGold": {
      const r = ratioVsAverage(live.xauHistory, live.metalHistory, w);
      if (!r) return null;
      const rich = r.gap >= 0;
      const meaning = f.key === "gsr"
        ? rich ? "silver is cheap against gold, which tends to revert in silver's favour" : "silver is rich against gold"
        : rich ? "gold is rich against silver — a mild headwind for gold" : "gold is cheap against silver";
      return `The gold/silver ratio is ${num(r.now, 1)}, ${pctAbs(r.gap)} ${rich ? "above" : "below"} its ${w}-day average of ${num(r.avg, 1)}: ${meaning}. ${readsAs(f)}`;
    }

    case "copperGold": {
      const r = ratioVsAverage(live.metalHistory, live.xauHistory, w);
      if (!r) return null;
      return `The copper/gold ratio is ${pctAbs(r.gap)} ${r.gap >= 0 ? "above" : "below"} its ${w}-day average — copper ${r.gap >= 0 ? "outpacing gold, a growth signal" : "lagging gold, a growth scare"}. ${readsAs(f)}`;
    }

    case "termStructure": {
      const c = mcx.curve;
      const r = curveRead(c);
      if (!c || !r) return null;
      return `${r.text} The slope works out to ${c.annualizedPct >= 0 ? "+" : "−"}${Math.abs(c.annualizedPct).toFixed(1)}% a year (±${TERM_STRUCTURE_FULL_PCT}% is full strength). ${readsAs(f)}`;
    }

    case "structuralBias": {
      const b = metal.engine.structuralBias;
      return `${metal.engine.structuralNote} Fixed at ${b >= 0 ? "+" : ""}${b} — it never reacts to today's data. ${readsAs(f)}`;
    }

    default:
      return null;
  }
}
