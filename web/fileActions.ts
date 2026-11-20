import type { UndoSkip } from "../shared/protocol";
import { confirmAction } from "./ConfirmDialog";
import { notify } from "./notices";
import { rpc } from "./rpc";
import { flash, getState, openDiff, refreshGit } from "./store";
import { toTarget } from "./lsp";
import { S } from "./strings";

// 파일 한 개 전체에 대한 Keep All 과 Undo All. 오른쪽 패널의 diff 탭 머리와 변경 패널의 파일 카드 `...` 메뉴가 같이 쓴다.

// 지금 디스크의 내용을 그 파일의 기준으로 삼는다(유지). 데몬에 저장돼 다음 비교부터 이 내용이 기준이다.
export async function keepFile(agentId: string, workspaceId: string, path: string) {
  const { text } = await rpc.call("files.read", { workspaceId, path });
  await rpc.call("changes.setOriginal", { agentId, path, original: text });
}

// 파일을 기준 내용으로 되돌린다. 새 파일(기준이 없음)이면 파일이 휴지통으로 가니 확인을 받는다(영구 삭제는 없다). 되돌렸으면 true.
// wording 은 확인 창 문구다: Undo All(명령 팔레트)과 Discard Changes(변경 목록 행 단추).
// 에이전트의 마지막 쓰기 뒤 바뀐 파일은 확인 창 전에 서버가 가려 알리고 건너뛴다(바깥 수정이나 다른 세션의 변경을 지우지 않는다).
export async function undoFile(agentId: string, path: string, relative: string, original: string | null, wording: "undo" | "discard" = "undo") {
  const check = await rpc.call("changes.checkUndo", { agentId, paths: [path] }).catch((e: Error) => (flash(e.message, "error"), null));
  if (!check) return false;
  if (check.allowed.length === 0) {
    reportSkipped(agentId, check.skipped, (p) => (p === path ? relative : p));
    return false;
  }
  const ok = wording === "discard" ? await confirmAction(S.discardChangesConfirm(relative, original === null), S.discardChangesButton, undefined, "warning") : await confirmAction(S.undoAllConfirm(relative, original === null), S.undoAllButton, undefined, "warning");
  if (!ok) return false;
  const reverted = await revertFiles(agentId, [{ path, text: original }], (p) => (p === path ? relative : p));
  return reverted.includes(path);
}

// 확인 없이 파일들을 기준 내용으로 되돌린다(확인은 부른 쪽이 한 번 한다). 서버가 파일마다 다시 검사해 건너뛴 파일은 알림으로 알린다. 되돌린 경로를 돌려준다.
export async function revertFiles(agentId: string, items: { path: string; text: string | null }[], relative: (path: string) => string): Promise<string[]> {
  const result = await rpc.call("changes.undo", { agentId, items }).catch((e: Error) => (flash(S.discardFailed(e.message), "error"), null));
  await refreshGit(agentId);
  if (!result) return [];
  reportSkipped(agentId, result.skipped, relative);
  return result.reverted;
}

// 건너뛴 이유가 하나면 그 이유를, 여럿이면 합친 문장을
export function skippedMessage(skipped: UndoSkip[]) {
  return new Set(skipped.map((s) => s.reason)).size === 1 ? S.undoSkipped(skipped.length, skipped[0].reason) : S.undoSkippedSeveral(skipped.length);
}

// 건너뛴 파일을 알린다. Compare 는 첫 파일의 diff 를 연다(나머지는 Changes 패널의 같은 표시로 이어서 본다).
export function reportSkipped(agentId: string, skipped: UndoSkip[], relative: (path: string) => string) {
  if (skipped.length === 0) return;
  const message = skippedMessage(skipped);
  const first = skipped[0].path;
  const workspaceId = getState().agents.find((a) => a.id === agentId)?.workspaceId;
  notify({
    message,
    severity: "warning",
    detail: skipped.map((s) => relative(s.path)).join(", "),
    key: "undo-skipped",
    actions: workspaceId ? [{ label: S.compare, run: () => openDiff(agentId, toTarget(first, workspaceId).workspaceId, first) }] : [],
  });
}
