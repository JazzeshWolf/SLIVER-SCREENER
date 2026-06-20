import { useState } from "preact/hooks";
import { useDashboard } from "./state/store";
import { TabBar, type Tab } from "./components/TabBar";
import { RegimeCard } from "./components/RegimeCard";
import { DirectionGauges } from "./components/DirectionGauges";
import { OutlookTab } from "./components/OutlookTab";
import { CotCard } from "./components/CotCard";
import { NewsTab } from "./components/NewsTab";
import { SpotStrip } from "./components/SpotStrip";
import { SellWindow } from "./components/SellWindow";
import { ThetaRing } from "./components/ThetaRing";
import { ExpectedMoveCone } from "./components/ExpectedMoveCone";
import { EventRadar } from "./components/EventRadar";
import { CorrelationPanel } from "./components/CorrelationPanel";
import { BasisPanel } from "./components/BasisPanel";
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
        </div>
        <button
          onClick={dash.refresh}
          className="text-xs text-white/50 flex items-center gap-1 active:text-white"
          disabled={dash.loading}
        >
          <span className={dash.loading ? "animate-spin" : ""}>⟳</span>
          {dash.loading ? "…" : timeAgo(dash.lastUpdated)}
        </button>
      </header>

      <main className="flex-1 px-3 space-y-3 pb-2">
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
                  <RegimeCard regime={dash.regime} scores={dash.scores} />
                )}
                <div className="flex gap-3">
                  {dash.premium && <SellWindow premium={dash.premium} />}
                  {dash.mcx && <ThetaRing mcx={dash.mcx} />}
                </div>
                <SpotStrip live={dash.live} mcx={dash.mcx} />
              </>
            )}

            {tab === "outlook" && dash.outlook && <OutlookTab outlook={dash.outlook} />}

            {tab === "vol" && dash.mcx && (
              <>
                <ExpectedMoveCone mcx={dash.mcx} events={dash.mcx.events} />
                <EventRadar events={dash.mcx.events} />
              </>
            )}

            {tab === "context" && (
              <>
                <CorrelationPanel live={dash.live} gsr={dash.derived?.gsr ?? null} />
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
