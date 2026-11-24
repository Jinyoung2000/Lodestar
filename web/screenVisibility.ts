import type { CenterViewName } from "./centerPanels";

export type VisibilitySettings = { showSlack?: boolean; showBoard?: boolean; followUpsEnabled?: boolean; assistantEnabled?: boolean } | null | undefined;

export const slackShown = (settings: VisibilitySettings): boolean => settings?.showSlack === true;
export const boardShown = (settings: VisibilitySettings): boolean => settings?.showBoard === true;
export const assistantShown = (settings: VisibilitySettings): boolean => settings?.assistantEnabled === true;
export const followUpsShown = (settings: VisibilitySettings): boolean => assistantShown(settings) && settings?.followUpsEnabled !== false;

export type Operator = boolean | null | undefined;

export const improvementsShown = (operator: Operator): boolean => operator === true;

export function centerViewHidden(view: CenterViewName, settings: VisibilitySettings, operator?: Operator): boolean {
  if (view === "improvements") return operator === false;
  if (view === "board") return !boardShown(settings);
  if (view === "inbox") return !slackShown(settings);
  if (view === "mate") return !assistantShown(settings);
  return false;
}

export function visibleCenterView(view: CenterViewName, settings: VisibilitySettings, operator?: Operator): CenterViewName {
  return centerViewHidden(view, settings, operator) ? "sessions" : view;
}

export function hiddenCommands(settings: VisibilitySettings, operator?: Operator): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!boardShown(settings)) {
    hidden.add("board");
    hidden.add("morningReview");
  }
  if (!slackShown(settings)) hidden.add("inbox");
  if (!assistantShown(settings)) hidden.add("assistant");
  if (!improvementsShown(operator)) hidden.add("improvements");
  return hidden;
}
