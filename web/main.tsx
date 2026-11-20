import "./perfCounter";
import "./fonts.css";
import "./tokens.css";
import "./tailwind.css";
import "./styles.css";
import "./compactView";
import { setHistoryMax, HISTORY_MAX } from "./browserHistory";
import { applyEditorFont } from "./editorFont";
import { applyUiType } from "./uiType";
import { applyHostColors } from "../shared/embed";
import { EMBED } from "./embed";
import { QUICK } from "./quickView"; // QUICKENTRY
import { setKeymapOverrides, setKeymapPreset } from "./keymap";
import * as store from "./store";
import { getState, subscribe } from "./store";
import { mark } from "./perfMarks";
import { exposeHooks } from "./verifyHooks";
import { installPerfHook } from "./perfHook";

mark("modules-evaluated");
if (import.meta.env.MODE === "perf") installPerfHook();
exposeHooks({ getState, store, applyHostColors });

// 테마: settings.theme 를 <html data-theme> 에, settings.themeStyle 을 <html data-style> 에 반영한다. system 은 OS 설정을 따르고, OS 설정이 바뀌면 다시 적용한다.
const lightMedia = window.matchMedia("(prefers-color-scheme: light)");
function applyTheme() {
  if (EMBED || QUICK) return;
  const theme = getState().settings?.theme ?? "dark";
  const next = theme === "system" ? (lightMedia.matches ? "light" : "dark") : theme === "black" ? "dark" : theme;
  // 같은 값을 다시 쓰면 문서 전체 스타일이 무효화된다. 스토어가 바뀔 때마다 부르므로 달라졌을 때만 쓴다.
  if (document.documentElement.dataset.theme !== next) document.documentElement.dataset.theme = next;
  // Black 테마: 다크 토큰 위에 바탕만 더 검게 덮는다(web/styles.css 의 html[data-black="true"]).
  if ((document.documentElement.dataset.black === "true") !== (theme === "black")) {
    if (theme === "black") document.documentElement.dataset.black = "true";
    else delete document.documentElement.dataset.black;
  }
  // 색 스타일은 <html data-style="webstorm"> 로만 켠다. lodestar 는 속성이 없는 기본 상태다.
  const style = getState().settings?.themeStyle === "webstorm" ? "webstorm" : null;
  if ((document.documentElement.dataset.style ?? null) !== style) {
    if (style) document.documentElement.dataset.style = style;
    else delete document.documentElement.dataset.style;
  }
}
lightMedia.addEventListener("change", applyTheme);
subscribe(applyTheme);
// 단축키 프리셋: settings.keymapPreset 를 단축키 표(web/keymap.ts)에 반영한다. 같은 값이면 아무 일도 하지 않는다.
subscribe(() => {
  setKeymapPreset(getState().settings?.keymapPreset ?? "vscode");
  setKeymapOverrides(getState().settings?.keymapOverrides);
});
// 코드 글꼴: settings 의 editorFont* 를 CSS 변수로 덮는다.
const applyFont = () => {
  applyEditorFont(getState().settings);
  applyUiType(getState().settings);
};
subscribe(applyFont);
subscribe(() => setHistoryMax(getState().settings?.browserMaxHistory ?? HISTORY_MAX));

if (EMBED) {
  const embed = EMBED;
  applyFont();
  void import("./EmbedSession").then(({ startEmbed }) => startEmbed(embed));
} else if (QUICK) {
  void import("./quickMain");
} else {
  applyTheme();
  applyFont();
  void import("./appMain");
}
