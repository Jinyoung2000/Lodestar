import type { CenterViewName } from "./centerPanels";

export type VisibilitySettings = { showSlack?: boolean; showBoard?: boolean; followUpsEnabled?: boolean; assistantEnabled?: boolean } | null | undefined;

export const slackShown = (settings: VisibilitySettings): boolean => settings?.showSlack === true;
export const boardShown = (settings: VisibilitySettings): boolean => settings?.showBoard === true;
export const followUpsShown = (settings: VisibilitySettings): boolean => settings?.followUpsEnabled !== false;
export const assistantShown = (settings: VisibilitySettings): boolean => settings?.assistantEnabled !== false;

export function centerViewHidden(view: CenterViewName, settings: VisibilitySettings): boolean {
  if (view === "board") return !boardShown(settings);
  if (view === "inbox") return !slackShown(settings);
  if (view === "mate") return !assistantShown(settings);
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
  if (!assistantShown(settings)) hidden.add("assistant");
  return hidden;
}
