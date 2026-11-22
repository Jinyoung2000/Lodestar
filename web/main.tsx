import "./perfCounter";
import "./fonts.css";
import "./tokens.css";
import "./tailwind.css";
import "./styles.css";
import "./multiRoot.css";
import "./compactView";
import { setHistoryMax, HISTORY_MAX } from "./browserHistory";
import { applyEditorFont } from "./editorFont";
import { applyUiType } from "./uiType";
import { applyHostColors } from "../shared/embed";
import { EMBED } from "./embed";
import { QUICK } from "./quickView";
import { setKeymapOverrides, setKeymapPreset } from "./keymap";
import * as store from "./store";
import { getState, subscribe } from "./store";
import { mark } from "./perfMarks";
import { exposeHooks } from "./verifyHooks";
import { installPerfHook } from "./perfHook";

mark("modules-evaluated");
if (import.meta.env.MODE === "perf") installPerfHook();
exposeHooks({ getState, store, applyHostColors });

const lightMedia = window.matchMedia("(prefers-color-scheme: light)");
function applyTheme() {
  if (EMBED || QUICK) return;
  const theme = getState().settings?.theme ?? "dark";
  const next = theme === "system" ? (lightMedia.matches ? "light" : "dark") : theme === "black" ? "dark" : theme;
  if (document.documentElement.dataset.theme !== next) document.documentElement.dataset.theme = next;
  if ((document.documentElement.dataset.black === "true") !== (theme === "black")) {
    if (theme === "black") document.documentElement.dataset.black = "true";
    else delete document.documentElement.dataset.black;
  }
  const style = getState().settings?.themeStyle === "webstorm" ? "webstorm" : null;
  if ((document.documentElement.dataset.style ?? null) !== style) {
    if (style) document.documentElement.dataset.style = style;
    else delete document.documentElement.dataset.style;
  }
}
lightMedia.addEventListener("change", applyTheme);
subscribe(applyTheme);
subscribe(() => {
  setKeymapPreset(getState().settings?.keymapPreset ?? "vscode");
  setKeymapOverrides(getState().settings?.keymapOverrides);
});
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
