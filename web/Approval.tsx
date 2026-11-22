import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PLAN_TOOL, QUESTION_TOOL } from "../shared/interactive";
import { NotionWriteCard } from "./NotionWriteCard";
import { approvalInputView, spacedJson } from "./approvalInput";
import { ApprovalHints } from "./ApprovalHints";
import { ApprovalDiff } from "./ApprovalDiff";
import { browserApproval } from "./browserToolLabels";
import { Check, ChevronDown, ChevronRight, Close } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { rpc } from "./rpc";
import { flash } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import type { PermissionItem } from "./timelineModel";
import { useEditPreview } from "./useEditPreview";
import { PlanCard } from "./PlanCard";
import { QuestionCard } from "./QuestionCard";
import { useAriaKeyShortcut, useCommandKey } from "./commandKeys";

export function ApprovalCard({ agentId, item }: { agentId: string; item: PermissionItem }) {
  if (item.toolName === QUESTION_TOOL) return <QuestionCard agentId={agentId} item={item} />;
  if (item.toolName === PLAN_TOOL) return <PlanCard agentId={agentId} item={item} />;
  if (item.notion) return <NotionWriteCard agentId={agentId} item={item} preview={item.notion} />;
  return <ToolApprovalCard agentId={agentId} item={item} />;
}

function ToolApprovalCard({ agentId, item }: { agentId: string; item: PermissionItem }) {
  const [expanded, setExpanded] = useState(false);
  const acceptKey = useCommandKey("acceptTool");
  const skipKey = useCommandKey("skipTool");
  const acceptAria = useAriaKeyShortcut("acceptTool");
  const skipAria = useAriaKeyShortcut("skipTool");
  const respond = (decision: "allow" | "allowAlways" | "deny") => {
    void rpc.call("agents.respondPermission", { agentId, itemId: item.id, decision }).catch((error: Error) => flash(error.message));
  };
  const browser = browserApproval(item.toolName, item.input);
  const preview = useEditPreview(agentId, item);
  const title = browser?.title ?? (preview?.isNew ? S.approvalCreateTitle : S.approvalTitle(item.toolName));
  const filePath = typeof item.input.file_path === "string" ? item.input.file_path : typeof item.input.notebook_path === "string" ? item.input.notebook_path : null;
  const { target, rest } = approvalInputView(item.toolName, item.input);
  const hasInput = Object.keys(rest).length > 0;
  return (
    <div className="approval-card" role="group" aria-label={title}>
      <div className="approval-head">
        <span className="approval-title">{title}</span>
        <button type="button" className="icon-button" aria-label={S.skip} title={S.skip} onClick={() => respond("deny")}>
          <Close />
        </button>
      </div>
      <div className="approval-target">
        <span>{preview?.isNew ? S.approvalCreateVerb : (S.verbsBase[item.toolName as keyof typeof S.verbsBase] ?? item.toolName)}</span>
        {filePath && (
          <span className="file-chip" data-file={JSON.stringify({ raw: filePath })}>
            <FileTypeIcon name={filePath.slice(filePath.lastIndexOf("/") + 1)} />
            {filePath.slice(filePath.lastIndexOf("/") + 1)}
          </span>
        )}
        {!filePath && target && <code className="code-chip" data-target={target.kind} title={target.text}>{target.text}</code>}
      </div>
      {browser?.message && <div className="approval-message">{browser.message}</div>}
      {browser?.code && (
        <>
          <pre className="approval-json approval-code">{browser.code}</pre>
          {browser.disclaimer && <div className="approval-message muted">{browser.disclaimer}</div>}
        </>
      )}
      {preview ? (
        <>
          <ApprovalDiff preview={preview} />
          <button type="button" className="approval-input-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            <span className="approval-input-chevron" data-open={expanded || undefined}>
              <ChevronRight size={14} />
            </span>
            {S.approvalInput}
          </button>
          {expanded && <pre className="approval-json"><JsonText value={JSON.stringify(item.input, null, 2)} /></pre>}
        </>
      ) : (
        hasInput && <ApprovalInput input={rest} />
      )}
      <div className="approval-actions">
        <div className="split-button">
          <Button variant="primary" size="default" data-approval-primary aria-keyshortcuts={acceptAria} title={S.allowOnceKey(acceptKey)} onClick={() => respond("allow")}>
            {S.allowOnce}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="primary" size="default" className="split-button-more" aria-label={S.allowMore}>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuItem onSelect={() => respond("allowAlways")}>
                <Check size={14} />
                <span>{S.allowInSession}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button variant="secondary" size="default" data-approval-skip aria-keyshortcuts={skipAria} title={S.skipKey(skipKey)} onClick={() => respond("deny")}>
          {S.skip}
        </Button>
        <ApprovalHints hints={S.approvalToolHints} />
      </div>
    </div>
  );
}

function ApprovalInput({ input }: { input: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const lineRef = useRef<HTMLSpanElement>(null);
  const line = spacedJson(input);
  useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [line, expanded]);
  return (
    <>
      <div className="approval-input-title">{S.approvalInput}</div>
      {expanded ? (
        <pre className="approval-json"><JsonText value={JSON.stringify(input, null, 2)} /></pre>
      ) : (
        <div className="approval-json approval-json-line"><span ref={lineRef}><JsonText value={line} /></span></div>
      )}
      {(clipped || expanded) && (
        <button type="button" className="approval-more" onClick={() => setExpanded((open) => !open)}>
          {expanded ? S.approvalSeeLess : S.approvalSeeMore}
        </button>
      )}
    </>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)/g;

function JsonText({ value }: { value: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of value.matchAll(JSON_TOKEN)) {
    if (match.index > last) parts.push(value.slice(last, match.index));
    const kind = match[1] ? (match[2] ? "key" : "string") : match[3] ? "number" : "word";
    parts.push(
      <span key={match.index} data-json={kind}>
        {match[1] ?? match[3] ?? match[4]}
      </span>,
    );
    if (match[2]) parts.push(match[2]);
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push(value.slice(last));
  return <>{parts}</>;
}
