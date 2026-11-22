import { runningWork } from "../shared/feedbackResume";
import { confirmDialog } from "./ConfirmDialog";
import { setKeepUnsavedOnUnload } from "./editorDocs";
import { flash, getState } from "./store";
import { S } from "./strings";

export async function reloadWindow() {
  if (!(await confirmUnsaved(S.reloadUnsavedDetail, S.reloadButton))) return;
  setKeepUnsavedOnUnload(false);
  const native = window.agentNavNative?.reloadWindow;
  if (native) await native().catch(() => location.reload());
  else location.reload();
}

export async function restartDaemon() {
  const native = window.agentNavNative?.restartDaemon;
  if (!native) return;
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
    setKeepUnsavedOnUnload(true);
    flash(S.restartDaemonDeferred);
  } else if (!started) {
    setKeepUnsavedOnUnload(true);
    flash(S.restartDaemonUnmanaged, "warning");
  }
}

export const canRestartDaemon = () => !!window.agentNavNative?.restartDaemon;

async function confirmUnsaved(detail: string, button: string) {
  if (!Object.keys(getState().dirtyTabs).length) return true;
  return (await confirmDialog({ title: S.unsavedChangesTitle, detail, buttons: [S.cancel, button], severity: "warning" })) === 1;
}
