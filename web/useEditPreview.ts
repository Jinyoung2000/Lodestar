import { useEffect, useMemo, useState } from "react";
import { isEditApproval, previewEdit, targetPath } from "./approvalPreview";
import { rpc } from "./rpc";
import type { PermissionItem } from "./timelineModel";

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
