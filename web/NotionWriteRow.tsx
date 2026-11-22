import { useState } from "react";
import type { TimelineItem } from "../shared/protocol";
import { Check, Codicon } from "./icons";
import { NotionWriteBody } from "./NotionWriteCard";
import { N } from "./notionStrings";
import type { PermissionItem } from "./timelineModel";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

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
