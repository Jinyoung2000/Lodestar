import { migrateLegacyStorage, scopedStorage, sweepStaleScopes, windowIdFromSearch, type KeyValueStorage } from "../shared/windows";

export const WINDOW_ID: string | null = typeof location === "undefined" ? null : windowIdFromSearch(location.search);

let scoped: KeyValueStorage | null | undefined;

export function windowStorage(): KeyValueStorage | null {
  if (scoped !== undefined) return scoped;
  try {
    if (typeof localStorage === "undefined") return (scoped = null);
    if (!WINDOW_ID) return (scoped = localStorage);
    migrateLegacyStorage(localStorage, WINDOW_ID);
    return (scoped = scopedStorage(localStorage, WINDOW_ID));
  } catch {
    return (scoped = null);
  }
}

export function sweepClosedWindows(liveIds: readonly string[]) {
  try {
    if (typeof localStorage !== "undefined") sweepStaleScopes(localStorage, new Set(liveIds));
  } catch {
  }
}
