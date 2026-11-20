import { useEffect, useMemo, useState } from "react";
import { isEditApproval, previewEdit, targetPath } from "./approvalPreview";
import { rpc } from "./rpc";
import type { PermissionItem } from "./timelineModel";

// Edit, Write, MultiEdit 승인에서 수정 전 파일을 읽어 변경 미리보기를 만든다. 읽는 동안과 다른 도구는 null(기존 JSON 보기).
// 데몬이 옛 버전이라 읽기 요청이 없으면 읽지 못한 것으로 보고 도구 입력의 조각만 비교한다.
export function useEditPreview(agentId: string, item: PermissionItem | undefined) {
  const path = item && isEditApproval(item.toolName) ? targetPath(item.input) : null;
  const [current, setCurrent] = useState<{ itemId: string; text: string | null | undefined } | null>(null);
  useEffect(() => {
    if (path === null || !item) return;
    let cancelled = false;
    void rpc
      .call("files.readOfAgent", { agentId, path })
      .then(({ text }) => text)
      .catch(() => undefined)
      .then((text) => !cancelled && setCurrent({ itemId: item.id, text }));
    return () => {
      cancelled = true;
    };
  }, [agentId, path, item?.id]);
  return useMemo(() => (path === null || !item || current?.itemId !== item.id ? null : previewEdit(item.toolName, item.input, current.text)), [path, current, item]);
}
