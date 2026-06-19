// ---------------------------------------------------------------------------
// Tiny localStorage cache so the app shows last-good values offline / on a
// failed fetch instead of blank or fabricated data.
// ---------------------------------------------------------------------------

const PREFIX = "sliver:";

export function cacheGet<T>(key: string): { value: T; at: number } | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as { value: T; at: number };
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ value, at: Date.now() }));
  } catch {
    // storage full / unavailable — non-fatal
  }
}
