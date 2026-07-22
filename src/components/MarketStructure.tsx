import type { McxData } from "../lib/types";
import { Card, SectionTitle, Implication, fmtInt } from "./ui";

/**
 * Price × open-interest structure — the classic four-quadrant read for an MCX
 * futures seller. Rising OI *confirms* a move (fresh positions with conviction);
 * falling OI means it's just unwinding (weaker, prone to fade). Footer folds in
 * the pinning/max-pain read from the option chain. All from live Upstox data.
 */
export function MarketStructure({ mcx }: { mcx: McxData }) {
  const F = mcx.mcx.silverFut;
  const pc = mcx.mcx.prevClose;
  const oi = mcx.mcx.oi;
  const oiChg = mcx.mcx.oiChg;
  if (F == null || pc == null || pc <= 0 || oi == null || oiChg == null) return null; // needs live feed

  const pricePct = ((F - pc) / pc) * 100;
  const prevOi = oi - oiChg;
  const oiPct = prevOi > 0 ? (oiChg / prevOi) * 100 : 0;
  const priceUp = pricePct >= 0;
  const oiUp = oiChg >= 0;

  const quiet = Math.abs(pricePct) < 0.05 && Math.abs(oiPct) < 0.3;

  type Read = { title: string; tag: string; tone: "bull" | "bear" | "warn" | "neutral"; blurb: string; seller: string };
  let r: Read;
  if (quiet) {
    r = {
      title: "Quiet / balanced", tag: "LOW ACTIVITY", tone: "neutral",
      blurb: "Little net change in price or open interest — no fresh positioning to read.",
      seller: "No structural edge from flow; lean on the regime and IV rank for strike selection.",
    };
  } else if (priceUp && oiUp) {
    r = {
      title: "Long buildup", tag: "CONVICTION", tone: "bull",
      blurb: "Price rising with rising open interest — fresh longs are being added; the up-move has conviction.",
      seller: "Favour selling puts into dips / below support; don't sell calls into a strengthening long base.",
    };
  } else if (!priceUp && oiUp) {
    r = {
      title: "Short buildup", tag: "CONVICTION", tone: "bear",
      blurb: "Price falling with rising open interest — fresh shorts are being added; the down-move has conviction.",
      seller: "Favour selling calls into rallies / above resistance; don't sell puts under a building short base.",
    };
  } else if (priceUp && !oiUp) {
    r = {
      title: "Short covering", tag: "UNWINDING", tone: "warn",
      blurb: "Price rising while open interest falls — shorts are covering, not fresh buying; pops can fade.",
      seller: "Don't chase the bounce — covering rallies often stall. Selling calls into strength works once it fizzles.",
    };
  } else {
    r = {
      title: "Long unwinding", tag: "UNWINDING", tone: "warn",
      blurb: "Price falling while open interest falls — longs are exiting, not aggressive shorting; downside may be limited.",
      seller: "Weak-handed longs leaving, but no fresh-short conviction — don't over-commit short puts, yet no rush to sell calls either.",
    };
  }

  const titleColor = { bull: "text-emerald-400", bear: "text-rose-400", warn: "text-amber-300", neutral: "text-sky-300" }[r.tone];
  const gex = mcx.gex;

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <SectionTitle>Market structure</SectionTitle>
        <span className="text-[10px] uppercase tracking-wider text-white/30">{r.tag}</span>
      </div>
      <div className={`text-2xl font-bold ${titleColor}`}>{r.title}</div>

      <div className="mt-1.5 flex items-center gap-4 text-sm">
        <span className="text-white/60">
          Price{" "}
          <span className={priceUp ? "text-emerald-300" : "text-rose-300"}>
            {priceUp ? "▲" : "▼"} {pricePct >= 0 ? "+" : ""}{pricePct.toFixed(2)}%
          </span>
        </span>
        <span className="text-white/60">
          Futures OI{" "}
          <span className={oiUp ? "text-emerald-300" : "text-rose-300"}>
            {oiUp ? "▲" : "▼"} {oiPct >= 0 ? "+" : ""}{oiPct.toFixed(1)}%
          </span>
        </span>
      </div>

      <p className="mt-2 text-sm text-white/70 leading-snug">{r.blurb}</p>
      <Implication tone={r.tone} label="Seller">{r.seller}</Implication>

      {gex && (gex.maxPain != null || gex.pinStrike != null) && (
        <p className="mt-2 pt-2 border-t border-white/5 text-[11px] text-white/40">
          Pinning: max pain {fmtInt(gex.maxPain)}
          {gex.regime && ` · gamma ${gex.regime}`}
          {gex.pinStrike != null && ` (pin ${fmtInt(gex.pinStrike)})`}
        </p>
      )}
    </Card>
  );
}
