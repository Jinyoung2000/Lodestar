import { runningWork } from "../shared/feedbackResume";
import { confirmDialog } from "./ConfirmDialog";
import { setKeepUnsavedOnUnload } from "./editorDocs";
import { flash, getState } from "./store";
import { S } from "./strings";

// Developer: Reload Window. Electron 이면 메인의 webContents.reload() 를 preload IPC 로 부르고, 웹 접속이면 location.reload() 다.
export async function reloadWindow() {
  if (!(await confirmUnsaved(S.reloadUnsavedDetail, S.reloadButton))) return;
  setKeepUnsavedOnUnload(false);
  const native = window.agentNavNative?.reloadWindow;
  if (native) await native().catch(() => location.reload());
  else location.reload();
}

// Developer: Restart Daemon. 메인이 데몬 utility process 를 끄고 다시 띄운 뒤 창을 다시 읽는다. 웹 접속에서는 명령이 목록에서 숨는다.
export async function restartDaemon() {
  const native = window.agentNavNative?.restartDaemon;
  if (!native) return;
  // FBREDO: 도는 세션과 개선(피드백) 작업을 따로 센다. 개선은 재시작 뒤 이어 가는 것이라 안내가 다르다.
  const { sessions, improvements } = runningWork(getState().agents, Object.values(getState().feedbacks));
  if (sessions > 0 || improvements > 0) {
    const title = sessions > 0 ? S.restartDaemonRunningTitle(sessions) : S.restartDaemonImprovementsTitle(improvements);
    const detail = [sessions > 0 ? S.restartDaemonRunningDetail : null, sessions > 0 && improvements > 0 ? `${S.restartDaemonImprovementsTitle(improvements)} ${S.restartDaemonImprovementsDetail(improvements)}` : null, sessions === 0 ? S.restartDaemonImprovementsDetail(improvements) : null].filter((line) => line !== null).join("\n\n");
    const choice = await confirmDialog({ title, detail, buttons: [S.cancel, S.restartDaemonButton], severity: "warning" });
    if (choice !== 1) return;
  }
  if (!(await confirmUnsaved(S.restartDaemonUnsavedDetail, S.restartDaemonButton))) return;
  setKeepUnsavedOnUnload(false);
  const started = await native().catch(() => false);
  if (started === "deferred") {
    // 직전 재시작 뒤 쿨다운 안이라 메인이 합쳐서 나중에 한다. 그동안은 아직 다시 읽히지 않으니 저장 안 한 내용 보관을 되돌려 둔다.
    setKeepUnsavedOnUnload(true);
    flash(S.restartDaemonDeferred);
  } else if (!started) {
    setKeepUnsavedOnUnload(true);
    flash(S.restartDaemonUnmanaged, "warning");
  }
}

export const canRestartDaemon = () => !!window.agentNavNative?.restartDaemon;

// 저장 안 한 에디터 탭이 있으면 묻는다. 계속해도 되면 true.
async function confirmUnsaved(detail: string, button: string) {
  if (!Object.keys(getState().dirtyTabs).length) return true;
  return (await confirmDialog({ title: S.unsavedChangesTitle, detail, buttons: [S.cancel, button], severity: "warning" })) === 1;
}
