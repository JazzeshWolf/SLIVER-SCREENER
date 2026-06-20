export type Tab = "score" | "outlook" | "vol" | "context";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "score", label: "Score", icon: "🎯" },
  { id: "outlook", label: "Outlook", icon: "🔭" },
  { id: "vol", label: "Vol", icon: "🌊" },
  { id: "context", label: "Context", icon: "🧭" },
];

export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="sticky bottom-0 z-10 mt-2 grid grid-cols-4 border-t border-white/10 bg-[#0a0e14]/95 backdrop-blur px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex flex-col items-center gap-0.5 rounded-lg py-1 text-[11px] ${
            tab === t.id ? "text-sky-300" : "text-white/40"
          }`}
        >
          <span className="text-base leading-none">{t.icon}</span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
