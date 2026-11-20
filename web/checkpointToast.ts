import { S } from "./strings";

// 체크포인트 복원 토스트. 확인 창이 센 "되돌림"과 "휴지통" 수와 같은 값으로 쓴다(발견 13: 휴지통 파일을 되돌림에 또 세던 것을 막는다).
export function restoreToastText(result: { files: number; reverted?: number; removed?: number }) {
  const removed = result.removed ?? 0;
  const reverted = result.reverted ?? Math.max(0, result.files - removed);
  if (removed === 0) return S.filesRestoredShell(reverted);
  return reverted === 0 ? S.filesTrashedOnly(removed) : S.filesRestoredTrash(reverted, removed);
}
