// ---------------------------------------------------------------------------
// Which metal the app is showing.
//
// Persisted in TWO places on purpose:
//  - the URL hash (#/gold), so a view is shareable and survives a reload; and
//  - localStorage, so opening the bare URL returns you to the metal you were
//    last looking at.
// The hash wins when present — an explicit link must beat a remembered default.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "preact/hooks";
import { DEFAULT_METAL, METAL_IDS, metalFor } from "../lib/metals.mjs";
import { cacheGet, cacheSet } from "../lib/cache";

const STORE_KEY = "metal";

/** The metal id in the URL hash, or null when the hash names no known metal. */
function metalFromHash(): string | null {
  const h = (typeof location !== "undefined" ? location.hash : "").replace(/^#\/?/, "").toLowerCase();
  return METAL_IDS.includes(h) ? h : null;
}

export interface MetalSelection {
  /** Active metal id, or null when the user has not chosen one yet. */
  metal: string | null;
  select: (id: string) => void;
  /** Return to the picker without forgetting the last choice. */
  clear: () => void;
}

export function useMetalSelection(): MetalSelection {
  const [metal, setMetal] = useState<string | null>(() => metalFromHash() ?? cacheGet<string>(STORE_KEY)?.value ?? null);

  // Back/forward and hand-edited URLs both arrive as hashchange.
  useEffect(() => {
    const onHash = () => setMetal(metalFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = useCallback((id: string) => {
    const valid = metalFor(id).id;
    cacheSet(STORE_KEY, valid);
    // Setting the hash fires hashchange, which updates state. Set it directly
    // too so the render doesn't wait a tick on browsers that batch the event.
    if (location.hash !== `#/${valid}`) location.hash = `#/${valid}`;
    setMetal(valid);
  }, []);

  const clear = useCallback(() => {
    if (location.hash) location.hash = "";
    setMetal(null);
  }, []);

  return { metal, select, clear };
}

export { DEFAULT_METAL };
