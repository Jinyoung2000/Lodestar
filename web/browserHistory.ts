import { useSyncExternalStore } from "react";

export type Visit = { url: string; title: string; at: number };
export type Favorite = { url: string; title: string };

export const HISTORY_MAX = 200;
let historyMax = HISTORY_MAX;
export const setHistoryMax = (max: number) => {
  historyMax = max;
};
export const FAVORITES_MAX = 100;

export function addVisit(list: Visit[], visit: Visit, max = HISTORY_MAX): Visit[] {
  const previous = list.find((v) => v.url === visit.url);
  const title = visit.title.trim() || previous?.title || "";
  return [{ ...visit, title }, ...list.filter((v) => v.url !== visit.url)].slice(0, max);
}

export function retitleVisit(list: Visit[], url: string, title: string): Visit[] {
  if (!title.trim() || !list.some((v) => v.url === url && v.title !== title)) return list;
  return list.map((v) => (v.url === url ? { ...v, title } : v));
}

export function toggleFavorite(list: Favorite[], favorite: Favorite): Favorite[] {
  if (list.some((f) => f.url === favorite.url)) return list.filter((f) => f.url !== favorite.url);
  return [{ url: favorite.url, title: favorite.title.trim() }, ...list].slice(0, FAVORITES_MAX);
}

export function matchesQuery(item: { url: string; title: string }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${item.title} ${item.url}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (time: number) => new Date(new Date(time).setHours(0, 0, 0, 0)).getTime();

export function groupByDay(list: Visit[], now: number): { label: string; items: Visit[] }[] {
  const today = startOfDay(now);
  const groups: { label: string; items: Visit[] }[] = [];
  for (const visit of list) {
    const day = startOfDay(visit.at);
    const label = day === today ? "Today" : day === today - DAY_MS ? "Yesterday" : new Date(day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(visit);
    else groups.push({ label, items: [visit] });
  }
  return groups;
}

const HISTORY_KEY = "agent-nav:browserHistory";
const FAVORITES_KEY = "agent-nav:browserFavorites";

function read<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

let history: Visit[] = read<Visit>(HISTORY_KEY).filter((v) => typeof v?.url === "string");
let favorites: Favorite[] = read<Favorite>(FAVORITES_KEY).filter((f) => typeof f?.url === "string");
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useHistory = () => useSyncExternalStore(subscribe, () => history);
export const useFavorites = () => useSyncExternalStore(subscribe, () => favorites);

export function recordVisit(url: string, title: string) {
  if (!url) return;
  history = addVisit(history, { url, title, at: Date.now() }, historyMax);
  write(HISTORY_KEY, history);
  emit();
}

export function recordTitle(url: string, title: string) {
  const next = retitleVisit(history, url, title);
  if (next === history) return;
  history = next;
  write(HISTORY_KEY, history);
  emit();
}

export function flipFavorite(url: string, title: string) {
  if (!url) return;
  favorites = toggleFavorite(favorites, { url, title });
  write(FAVORITES_KEY, favorites);
  emit();
}
