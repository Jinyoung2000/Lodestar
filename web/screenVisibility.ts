import type { CenterViewName } from "./centerPanels";

export type VisibilitySettings = { showSlack?: boolean; showBoard?: boolean } | null | undefined;

export const slackShown = (settings: VisibilitySettings): boolean => settings?.showSlack === true;
export const boardShown = (settings: VisibilitySettings): boolean => settings?.showBoard === true;

export function centerViewHidden(view: CenterViewName, settings: VisibilitySettings): boolean {
  if (view === "board") return !boardShown(settings);
  if (view === "inbox") return !slackShown(settings);
  return false;
}

export function visibleCenterView(view: CenterViewName, settings: VisibilitySettings): CenterViewName {
  return centerViewHidden(view, settings) ? "sessions" : view;
}

export function hiddenCommands(settings: VisibilitySettings): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!boardShown(settings)) {
    hidden.add("board");
    hidden.add("morningReview");
  }
  if (!slackShown(settings)) hidden.add("inbox");
  return hidden;
}
