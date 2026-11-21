export const ACTIVITY_VIEWS = ["files", "changes", "scm", "search", "card"] as const;

export type ActivityView = (typeof ACTIVITY_VIEWS)[number];

export type ActivityBarPrefs = { order: ActivityView[]; hidden: ActivityView[]; hiddenBadges: ActivityView[] };

export const DEFAULT_ACTIVITY_BAR: ActivityBarPrefs = { order: [...ACTIVITY_VIEWS], hidden: [], hiddenBadges: [] };

const isView = (value: unknown): value is ActivityView => ACTIVITY_VIEWS.includes(value as ActivityView);

const viewList = (value: unknown): ActivityView[] => (Array.isArray(value) ? [...new Set(value.filter(isView))] : []);

export function sanitizeActivityBar(value: unknown): ActivityBarPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_ACTIVITY_BAR, order: [...DEFAULT_ACTIVITY_BAR.order] };
  const raw = value as Record<string, unknown>;
  const known = viewList(raw.order);
  const order = [...known, ...ACTIVITY_VIEWS.filter((view) => !known.includes(view))];
  const hidden = viewList(raw.hidden);
  const everyFixedHidden = ACTIVITY_VIEWS.filter((view) => view !== "card").every((view) => hidden.includes(view));
  return { order, hidden: everyFixedHidden ? [] : hidden, hiddenBadges: viewList(raw.hiddenBadges) };
}

export function shownViews(prefs: ActivityBarPrefs, hasCard: boolean): ActivityView[] {
  return prefs.order.filter((view) => !prefs.hidden.includes(view) && (view !== "card" || hasCard));
}

export function listedViews(prefs: ActivityBarPrefs, hasCard: boolean): ActivityView[] {
  return prefs.order.filter((view) => view !== "card" || hasCard);
}

export function moveView(order: readonly ActivityView[], view: ActivityView, before: ActivityView | null): ActivityView[] {
  if (view === before) return [...order];
  const rest = order.filter((item) => item !== view);
  const at = before === null ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, at < 0 ? rest.length : at), view, ...rest.slice(at < 0 ? rest.length : at)];
}

export function setViewHidden(prefs: ActivityBarPrefs, view: ActivityView, hide: boolean, hasCard: boolean): ActivityBarPrefs {
  if (hide && shownViews(prefs, hasCard).every((item) => item === view)) return prefs;
  const hidden = hide ? [...new Set([...prefs.hidden, view])] : prefs.hidden.filter((item) => item !== view);
  return { ...prefs, hidden };
}

export function setBadgeHidden(prefs: ActivityBarPrefs, view: ActivityView, hide: boolean): ActivityBarPrefs {
  const hiddenBadges = hide ? [...new Set([...prefs.hiddenBadges, view])] : prefs.hiddenBadges.filter((item) => item !== view);
  return { ...prefs, hiddenBadges };
}
