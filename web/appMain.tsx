import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initBrowserHost } from "./browserHost";
import { initLocalhostLinks } from "./localhostLinks";
import { initNotion } from "./notionStore";
import { initNotionLinks } from "./notionLinks";
import { initSessionLinks } from "./sessionLinks";
import { initPrLinks } from "./prLinks";
import { initNotionScreen } from "./notionScreen"; // NOTION2
import { initNotes } from "./notesStore"; // NOTES
import { initDirection } from "./direction";
import { initQuickEntrySync } from "./quickEntrySync"; // QUICKENTRY
import { currentSelection } from "./Editor";
import { initSessionActions } from "./sessionActions";
import { startSessionTracking } from "./sessionSwitcher";
import { initEditorDocs } from "./editorDocs";
import { initScrollbars } from "./scrollbars";
import { runCommand } from "./shortcuts";
import { openFolderApi } from "./openFolder"; // OPENFOLDER
import { getPr, openPr } from "./prStore";
import { initStore, persistWindowState, saveReloadSnapshot, getState, subscribe } from "./store";
import { flushDrafts } from "./composerState";
import { initWindowSweep } from "./windowSweep";
import { initOverlayFocus } from "./overlayFocus";
import { flushWindowChanged, noteWindowChanged, setHotAliveProvider, setWindowSaver } from "./windowState";
import { mark, trackStartup } from "./perfMarks";
import { prefetchViews } from "./lazyViews";
import { exposeHooks } from "./verifyHooks";

// 앱 창의 시작점(web/main.tsx 가 앱 창일 때만 불러온다). 미니 채팅과 빠른 입력창은 이 모듈의 코드를 읽지 않는다.
exposeHooks({ currentSelection, runCommand, openFolder: openFolderApi, openPr, getPr });
// 창을 다시 읽어도(⌘R) 탭 순서와 에디터 그룹이 이어지게 닫히기 전에 맡겨 둔다.
window.addEventListener("pagehide", saveReloadSnapshot);
// 입력창 초안은 글자를 칠 때 바로 저장소에 쓴다(web/composerState.ts). 긴 글만 묶어서 쓰므로, 창이 닫히거나 다시 읽히거나 숨겨지기 전에 남은 것을 쓴다. beforeunload 는 막지 않는다(returnValue 를 두면 메인의 will-prevent-unload 가 뜬다).
const flushBeforeLeaving = () => {
  flushDrafts();
  flushWindowChanged();
};
window.addEventListener("beforeunload", flushBeforeLeaving);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushBeforeLeaving();
});
// 앱을 껐다 켜도 칸, 탭, 패널이 돌아오도록 상태가 바뀔 때마다(짧은 지연 뒤) 저장본을 남긴다. 스크롤과 커서와 초안은 각자 noteWindowChanged 로 알린다.
setWindowSaver(persistWindowState);
subscribe(noteWindowChanged);
// FIX6A: 저장 안 한 에디터 내용을 보관할 때 열려 있는 탭만 대상으로 한다.
setHotAliveProvider(() => new Set(getState().tabs.map((t) => t.key)));

initStore();
trackStartup();
initSessionActions();
startSessionTracking();
initEditorDocs();
initScrollbars();
initDirection();
initBrowserHost();
initLocalhostLinks();
initNotion();
initNotionLinks();
initSessionLinks();
initPrLinks();
initNotionScreen(); // NOTION2
initNotes(); // NOTES
initQuickEntrySync(); // QUICKENTRY
initWindowSweep();
initOverlayFocus();
mark("render-called");
createRoot(document.getElementById("root")!).render(<App />);
prefetchViews();
