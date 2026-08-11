import { useState } from "preact/hooks";
import { useDashboard } from "./state/store";
import { TabBar, type Tab } from "./components/TabBar";
import { RegimeCard } from "./components/RegimeCard";
import { FactorBreakdown } from "./components/FactorBreakdown";
import { MarketStructure } from "./components/MarketStructure";
import { DirectionGauges } from "./components/DirectionGauges";
import { OutlookTab } from "./components/OutlookTab";
import { CotCard } from "./components/CotCard";
import { NewsTab } from "./components/NewsTab";
import { SpotStrip } from "./components/SpotStrip";
import { SellWindow } from "./components/SellWindow";
import { ThetaRing } from "./components/ThetaRing";
import { ExpectedMoveCone } from "./components/ExpectedMoveCone";
import { EventRadar } from "./components/EventRadar";
import { GexCard } from "./components/GexCard";
import { FearGauge } from "./components/FearGauge";
import { OptionChainTable } from "./components/OptionChainTable";
import { SellCandidates } from "./components/SellCandidates";
import { KeyLevels } from "./components/KeyLevels";
import { PositioningVol } from "./components/PositioningVol";
import { PositionsPanel } from "./components/PositionsPanel";
import { CorrelationPanel } from "./components/CorrelationPanel";
import { CurveCard } from "./components/CurveCard";
import { BasisPanel } from "./components/BasisPanel";
import { FeedBanner } from "./components/FeedBanner";
import { ExpirySelector } from "./components/ExpirySelector";
import { timeAgo } from "./components/ui";

export function App() {
  const dash = useDashboard();
  const [tab, setTab] = useState<Tab>("score");

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">🥈 Sliver Screener</h1>
          {dash.mcx?.estimated && (
            <span className="text-[9px] uppercase tracking-wide text-amber-300/80 border border-amber-400/30 rounded px-1 py-0.5">
              MCX est.
            </span>
          )}
          {dash.mcx?.liveParity && !dash.mcx?.estimated && (
            <span className="text-[9px] uppercase tracking-wide text-sky-300/80 border border-sky-400/30 rounded px-1 py-0.5" title="MCX price computed live from spot × parity; OI/IV from the last server run">
              live ~parity
            </span>
          )}
        </div>
        <button
          onClick={dash.refresh}
          className="text-xs text-white/50 flex items-center gap-1 active:text-white"
          disabled={dash.loading}
        >
          <span className={dash.loading ? "animate-spin" : ""}>⟳</span>
          {dash.loading ? "…" : timeAgo(dash.lastUpdated)}
          <span className="text-[8px] text-white/20 ml-1">v{__BUILD_ID__}</span>
        </button>
      </header>

      <main className="flex-1 px-3 space-y-3 pb-2">
        {dash.mcx && <FeedBanner mcx={dash.mcx} />}
        {(tab === "score" || tab === "sell" || tab === "vol" || tab === "chain") && dash.expiries && (
          <ExpirySelector
            expiries={dash.expiries}
            selected={dash.selectedExpiry}
            onSelect={dash.setSelectedExpiry}
          />
        )}
        {!dash.live && (
          <div className="text-center text-white/40 py-16">Loading market data…</div>
        )}

        {dash.live && (
          <>
            {tab === "score" && (
              <>
                {dash.regime && dash.scores && (
                  <DirectionGauges
                    regime={dash.regime}
                    scores={dash.scores}
                    outlook={dash.outlook}
                    onOpenOutlook={() => setTab("outlook")}
                  />
                )}
                {dash.regime && dash.scores && (
                  <RegimeCard regime={dash.regime} scores={dash.scores} track={dash.track} />
                )}
                {dash.regime && dash.scores && (
                  <FactorBreakdown
                    decision={dash.scores[dash.regime.dteHorizon]}
                    horizon={dash.regime.dteHorizon}
                  />
                )}
                {dash.mcx && <MarketStructure mcx={dash.mcx} />}
                <div className="flex gap-3">
                  {dash.premium && (
                    <SellWindow
                      premium={dash.premium}
                      ivEstimated={dash.mcx?.options.ivRankEstimated ?? dash.mcx?.options.ivEstimated}
                    />
                  )}
                  {dash.mcx && <ThetaRing mcx={dash.mcx} />}
                </div>
                {dash.mcx && <PositionsPanel mcx={dash.mcx} />}
                <SpotStrip live={dash.live} mcx={dash.mcx} />
              </>
            )}

            {tab === "sell" && dash.mcx && (
              <>
                <SellCandidates
                  mcx={dash.mcx}
                  score={dash.regime ? dash.scores?.[dash.regime.dteHorizon].score ?? null : null}
                  regime={dash.regime}
                />
                {dash.premium && (
                  <SellWindow
                    premium={dash.premium}
                    ivEstimated={dash.mcx.options.ivRankEstimated ?? dash.mcx.options.ivEstimated}
                  />
                )}
                <EventRadar events={dash.mcx.events} prints={dash.mcx.prints} />
              </>
            )}

            {tab === "chain" && dash.mcx && (
              <>
                <OptionChainTable mcx={dash.mcx} />
                <KeyLevels mcx={dash.mcx} />
                <PositioningVol mcx={dash.mcx} />
              </>
            )}

            {tab === "outlook" && dash.outlook && <OutlookTab outlook={dash.outlook} />}

            {tab === "vol" && dash.mcx && (
              <>
                <FearGauge mcx={dash.mcx} />
                <ExpectedMoveCone mcx={dash.mcx} events={dash.mcx.events} />
                <GexCard gex={dash.mcx.gex} fut={dash.mcx.mcx.fut} />
                <EventRadar events={dash.mcx.events} prints={dash.mcx.prints} />
              </>
            )}

            {tab === "context" && (
              <>
                <CorrelationPanel live={dash.live} gsr={dash.derived?.gsr ?? null} />
                {dash.mcx && <CurveCard mcx={dash.mcx} />}
                {dash.mcx && <CotCard mcx={dash.mcx} />}
                {dash.mcx && dash.derived && <BasisPanel mcx={dash.mcx} derived={dash.derived} />}
              </>
            )}

            {tab === "news" && <NewsTab news={dash.mcx?.news ?? []} />}
          </>
        )}
      </main>

      <TabBar tab={tab} onChange={setTab} />
    </div>
  );
}
