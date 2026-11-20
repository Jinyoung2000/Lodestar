import { useState } from "react";
import type { TimelineItem } from "../shared/protocol";
import { Check, Codicon } from "./icons";
import { NotionWriteBody } from "./NotionWriteCard";
import { N } from "./notionStrings";
import type { PermissionItem } from "./timelineModel";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

// 처리된 Notion 쓰기 제안(notion_update_page, notion_create_pages)의 대화 기록 줄. 승인 카드로 승인했든 Bypass Permissions 가 바로 반영했든 같은 줄이다.
// 펼치면 승인 카드가 보여 준 것과 같은 diff 가 나와서, 무엇이 Notion 에 갔는지 나중에도 확인할 수 있다.
export function NotionWriteRow({ tool, permission }: { tool: ToolItem | null; permission: PermissionItem }) {
  const [open, setOpen] = useState(false);
  const preview = permission.notion;
  if (!preview) return null;
  const denied = permission.status === "denied";
  const failed = !denied && tool?.status === "error";
  const running = !denied && !failed && tool?.status === "running";
  const label = denied ? N.writeRejected : failed ? N.writeFailed : running ? N.writeApplying : N.writeApplied;
  const target = preview.kind === "create" ? N.writeCreates(preview.creates?.length ?? 1) : (preview.target?.title ?? null);
  return (
    <details className="step notion-write-row" data-status={denied ? "denied" : failed ? "error" : running ? "running" : "done"} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="step-icon">{denied || failed ? <Codicon name="error" size={14} /> : <Check size={14} />}</span>
        <span className="step-verb">{label}</span>
        {target && <code className="code-chip">{target}</code>}
        {permission.auto && <span className="faint xs">{N.writeAutoNote}</span>}
      </summary>
      {open && (
        <div className="notion-write-row-body">
          <NotionWriteBody preview={preview} />
        </div>
      )}
    </details>
  );
}
