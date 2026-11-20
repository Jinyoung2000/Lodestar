import type { CenterViewName } from "./centerPanels";

// Slack(멘션 Inbox)와 Board 화면을 설정(showSlack, showBoard)으로 숨기는 판정. store 없이 시험할 수 있게 순수 함수로 뒀다. 시험: test/screenvisibility.test.ts
// 기본값은 둘 다 숨김이라, 설정을 아직 못 읽었거나(null) 키가 없는 옛 설정 파일은 숨김으로 본다.
export type VisibilitySettings = { showSlack?: boolean; showBoard?: boolean } | null | undefined;

export const slackShown = (settings: VisibilitySettings): boolean => settings?.showSlack === true;
export const boardShown = (settings: VisibilitySettings): boolean => settings?.showBoard === true;

// 숨겨진 화면이면 true. 숨기는 대상은 board 와 inbox 뿐이다.
export function centerViewHidden(view: CenterViewName, settings: VisibilitySettings): boolean {
  if (view === "board") return !boardShown(settings);
  if (view === "inbox") return !slackShown(settings);
  return false;
}

// 보여 줄 가운데 화면. 숨겨진 화면이 저장돼 있거나 요청되면 세션 화면으로 돌린다.
export function visibleCenterView(view: CenterViewName, settings: VisibilitySettings): CenterViewName {
  return centerViewHidden(view, settings) ? "sessions" : view;
}

// 숨겨진 동안 단축키 표, 명령 팔레트, 단축키 목록에서 뺄 명령 이름. morningReview 는 Board 안의 기능이라 Board 와 함께 빠진다.
export function hiddenCommands(settings: VisibilitySettings): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!boardShown(settings)) {
    hidden.add("board");
    hidden.add("morningReview");
  }
  if (!slackShown(settings)) hidden.add("inbox");
  return hidden;
}
