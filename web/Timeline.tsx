import DOMPurify from "dompurify";
import { parseMarkdown } from "./markdownParse";
import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { endsInsideFence, streamingChunks } from "./streamingChunks";
import { FeedbackAttachmentChip, FeedbackBodies } from "./DiffFeedbackChips";
import { HandoffBubbleChip } from "./HandoffChip";
import { AgentStepRow } from "./Subagents";
import { AddToBoardButton } from "./AddToBoardButton";
import { TaskRunRow, TaskStepRow } from "./Tasks";
import { isTaskTool } from "../shared/tasks";
import { isAgentTool } from "../shared/subagents";
import { FeedbackRetryRow } from "./FeedbackRetry";
import { withoutQuestionMarker } from "../shared/feedbackQuestion";
import type { TimelineItem, TurnChangedFile, TurnChanges, UserAttachment } from "../shared/protocol";
import { formatBytes } from "../shared/files";
import { CheckpointActions, RestoredMarker, TimelineContext } from "./Checkpoint";
import { linkifyElement, type FileRef } from "./fileRefs";
import { linkifySessionRefs, MARKDOWN_URI } from "./sessionLinks";
import { markFileRefs, useFileRefVersion } from "./fileRefMark";
import { BookCompact, Check, ChevronDown, ChevronRightCompact, Codicon, Copy, DotSpinner, Edit, Spark, TerminalCompact, Tools } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { toTarget } from "./lsp";
import { useStuckBubble } from "./stuckBubble";
import { addCodeCopyButtons, heatmapTables, highlightCodeBlocks } from "./markdownCode";
import { addSlackCopyButtons, slackPreviews } from "./slackPreview";
import { addMermaidButtons, mermaidPreviews } from "./mermaidPreview";
import { MermaidLightbox } from "./MermaidLightbox";
import { useLanguagesVersion } from "./languages";
import { BROWSER_TOOL_PREFIX } from "../server/browserToolNames";
import { browserToolLabel } from "./browserToolLabels";
import { rpc } from "./rpc";
import { openNotionScreen } from "./notionScreen";
import { NotionWriteRow } from "./NotionWriteRow";
import { AsideStepRow } from "./AsideStepRow";
import { InlineMedia } from "./MediaPreview";
import { hideLocalImages } from "./mediaHtml";
import { mayContainMedia } from "../shared/media";
import { asideTitle } from "./asideStep";
import { isAsideTool } from "../shared/asideTool";
import { getState, openAgent, openChanges, openDiff, openFile, setChangesScope, useStore, type BrowserTab } from "./store";
import { S } from "./strings";
import { createdNewFile, currentStep, foldTaskSteps, formatClock, interactiveStep, modelLabel, queuedStepIds, stepsChanges, systemMessageView, toolChanges, turnFooter, type PermissionItem, type StepEntry, type Turn, type UserItem } from "./timelineModel";
import { isInteractiveTool } from "../shared/interactive";

export { ApprovalCard } from "./Approval";
export { groupTurns, reuseTurns, splitTurns } from "./timelineModel";

export const TurnView = memo(function TurnView({ turn, first, last, live }: { turn: Turn; first: boolean; last: boolean; live: boolean }) {
  const { agentId } = useContext(TimelineContext);
  const models = useStore((s) => s.meta?.models);
  const { assistant, result, text } = turnFooter(turn);
  const showFooter = assistant && (!live || result);
  const changes = result?.changes;
  return (
    <div className="turn" data-turn-key={turn.key} data-last={last || undefined}>
      {turn.user && <UserHead user={turn.user} first={first} />}
      {turn.blocks.map((block) => {
        if (block.kind === "item") return block.item.kind === "restored" ? null : <TimelineRow key={block.item.id} item={block.item} />;
        const folded = foldTaskSteps(block.items);
        if (folded.length === 1) {
          const [only] = folded;
          if (only.kind === "tasks") return <TaskRunRow key={block.key} items={only.items} />;
          const waiting = (only.entry.item.kind === "permission" ? only.entry.item : only.entry.permission)?.status === "pending";
          return waiting ? null : <StepRow key={block.key} item={only.entry.item} permission={only.entry.permission} />;
        }
        return <StepsBlock key={block.key} steps={block.items} finished={block.finished} durationMs={block.durationMs} live={live} />;
      })}
      {showFooter && (
        <div className="turn-footer" data-last={last || undefined}>
          {!last && changes?.list && <TurnChangesList agentId={agentId} changes={changes} list={changes.list} />}
          {!last && changes && !changes.list && (
            <button
              type="button"
              className="turn-changes"
              title={S.filesChangedTip}
              onClick={() => {
                setChangesScope(agentId, "lastTurn");
                openChanges();
              }}
            >
              <span>{S.filesChangedLine(changes.files)}</span>
              <DiffCounts additions={changes.additions} deletions={changes.deletions} />
            </button>
          )}
          <div className="response-bar">
            <CopyButton text={text} />
            <AddToBoardButton agentId={agentId} itemId={assistant.id} text={text} part={null} kind="response" className="icon-button" />
            <span className="spacer" />
            <ResponseTime at={assistant.at} durationMs={result?.durationMs ?? null} tokens={result?.tokens ?? null} />
            {assistant.model && (
              <>
                <span className="meta-dot" />
                <span className="response-meta" title={assistant.model}>{modelLabel(assistant.model, models ?? [], false)}</span>
              </>
            )}
          </div>
        </div>
      )}
      {turn.blocks.map((block) => (block.kind === "item" && block.item.kind === "restored" ? <RestoredMarker key={block.item.id} redoable={block.item.redoable} chatOnly={block.item.chatOnly} /> : null))}
    </div>
  );
});

function TurnChangesList({ agentId, changes, list }: { agentId: string; changes: TurnChanges; list: TurnChangedFile[] }) {
  const workspaceId = useContext(TimelineContext).workspaceId ?? null;
  return (
    <details className="turn-changes-details">
      <summary className="turn-changes">
        <span>{S.filesChangedLine(changes.files)}</span>
        <DiffCounts additions={changes.additions} deletions={changes.deletions} />
        <span className="chev">
          <ChevronRightCompact />
        </span>
      </summary>
      <div className="turn-changes-list">
        {list.map((file) => {
          const slash = file.path.lastIndexOf("/");
          return (
            <button
              key={file.path}
              type="button"
              className="turn-changes-file"
              title={`${file.path}\n${S.openToSideAlt}`}
              disabled={workspaceId === null}
              onClick={(e) => workspaceId && openDiff(agentId, toTarget(file.path, workspaceId).workspaceId, file.path, { side: e.altKey })}
            >
              <FileTypeIcon name={file.path.slice(slash + 1)} />
              <span className="turn-changes-name">{file.path.slice(slash + 1)}</span>
              <span className="turn-changes-dir">{file.path.slice(0, slash)}</span>
              <DiffCounts additions={file.additions} deletions={file.deletions} />
            </button>
          );
        })}
      </div>
    </details>
  );
}

const UserHead = memo(function UserHead({ user, first }: { user: UserItem; first: boolean }) {
  const { codex, locked } = useContext(TimelineContext);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const stuck = useStuckBubble(sentinelRef, bubbleRef);
  return (
    <>
      <span className="turn-sentinel" ref={sentinelRef} aria-hidden="true" />
      <div className="turn-user" ref={bubbleRef} data-item-id={user.id} data-stuck={stuck || undefined}>
        {!codex && !locked?.has(user.id) && <CheckpointActions user={user} first={first} />}
        {user.attachments?.length ? (
          <div className="user-attachments">
            {user.attachments.map((attachment) => (
              <AttachmentChip key={attachmentKey(attachment)} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {user.attachments?.length ? <FeedbackBodies attachments={user.attachments} /> : null}
        {(user.shown !== "" || !user.attachments?.length) && (
          <div className="row-user">
            <Markdown className="row-user-text" text={user.shown ?? user.text} breaks linkify={false} />
          </div>
        )}
      </div>
    </>
  );
});

function AttachmentChip({ attachment }: { attachment: UserAttachment }) {
  const { agentId, workspaceId = null } = useContext(TimelineContext);
  if (attachment.kind === "diffFeedback") return <FeedbackAttachmentChip agentId={agentId} attachment={attachment} />;
  if (attachment.kind === "screenshot" || attachment.kind === "image") return <ScreenshotChip attachment={attachment} />;
  if (attachment.kind === "file") return <FileBubbleChip attachment={attachment} />;
  if (attachment.kind === "handoff") return <HandoffBubbleChip label={attachment.label} id={attachment.id} />;
  if (attachment.kind === "notion") return <NotionBubbleChip label={attachment.label} url={attachment.url} />;
  const { path, line } = attachment;
  const file = path ? path.slice(path.lastIndexOf("/") + 1) : null;
  const where = file ? (line ? `${file}:${line}` : file) : null;
  return (
    <button type="button" className="user-attachment mono" title={path ? `${path}${line ? `:${line}` : ""}\n${S.openToSideAlt}` : attachment.label} disabled={!path || !workspaceId} onClick={(e) => path && workspaceId && openFile({ workspaceId, path, line: line ?? undefined }, { side: e.altKey })}>
      <Codicon name="symbol-class" size={12} />
      <span className="user-attachment-name">{attachment.label}</span>
      {where && <span className="user-attachment-where">{where}</span>}
    </button>
  );
}

function attachmentKey(attachment: UserAttachment) {
  if (attachment.kind === "element") return `${attachment.label}:${attachment.path}:${attachment.line}`;
  if (attachment.kind === "screenshot") return `screenshot:${attachment.label}`;
  if (attachment.kind === "notion") return `notion:${attachment.url}`;
  if (attachment.kind === "file") return `file:${attachment.path}`;
  return attachment.id;
}

function FileBubbleChip({ attachment }: { attachment: Extract<UserAttachment, { kind: "file" }> }) {
  return (
    <span className="user-attachment user-attachment-file mono" title={attachment.path}>
      <Codicon name="file" size={12} />
      <span className="user-attachment-name">{attachment.label}</span>
      <span className="user-attachment-where">{formatBytes(attachment.bytes)}</span>
    </span>
  );
}

function NotionBubbleChip({ label, url }: { label: string; url: string }) {
  return (
    <button type="button" className="user-attachment" title={url} onClick={() => openNotionScreen(url)}>
      <Codicon name="file" size={12} />
      <span className="user-attachment-name">{label}</span>
    </button>
  );
}

function ScreenshotChip({ attachment }: { attachment: Extract<UserAttachment, { kind: "screenshot" | "image" }> }) {
  return (
    <span className="user-attachment user-attachment-shot mono" title={attachment.label}>
      <img className="user-attachment-thumb" src={attachment.thumb} alt="" />
      <span className="user-attachment-name">{attachment.label}</span>
    </span>
  );
}

function ResponseTime({ at, durationMs, tokens }: { at: string | undefined; durationMs: number | null; tokens: number | null }) {
  const [hover, setHover] = useState(false);
  const clock = formatClock(at);
  return (
    <span className="response-meta response-time" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {hover && durationMs !== null ? `${formatElapsed(durationMs)}${tokens ? `, ${formatTokens(tokens)} tokens` : ""}` : clock}
    </span>
  );
}

function formatTokens(count: number) {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

function formatElapsed(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const label = copied ? S.copiedResponse : S.copyResponse;
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} onClick={copy}>
      {copied ? <Check /> : <Copy />}
    </button>
  );
}

export function DiffCounts({ additions, deletions, title }: { additions: number; deletions: number; title?: string }) {
  return (
    <span className="diff-counts" aria-label={S.changeCountAria(additions, deletions)} title={title}>
      <span className="diff-add">+{additions}</span>
      <span className="diff-del">-{deletions}</span>
    </span>
  );
}

export function ThinkingIndicator() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setIndex((i) => (i + 1) % S.thinkingWords.length), THINKING_WORD_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="thinking-indicator" role="status">
      <DotSpinner size={14} />
      <span className="shimmer-text">{S.thinkingWords[index]}</span>
    </div>
  );
}

const THINKING_WORD_MS = 4000;

export function PendingNotice({ count }: { count: number }) {
  return (
    <div className="thinking-indicator" role="status">
      <DotSpinner state="waiting" size={14} />
      <span>{S.confirmationsPending(count)}</span>
    </div>
  );
}

export const StepsBlock = memo(function StepsBlock({ steps, finished, durationMs, live }: { steps: StepEntry[]; finished: boolean; durationMs: number | null; live: boolean }) {
  const expandSteps = useStore((s) => s.settings?.expandSteps === true);
  const { revealAll } = useContext(TimelineContext);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? expandSteps;
  const [built, setBuilt] = useState(false);
  const showBody = built || revealAll || manualOpen === true || (manualOpen === null && expandSteps);
  if (showBody && !built) setBuilt(true);
  const pending = steps.some(({ item, permission }) => (item.kind === "permission" ? item : permission)?.status === "pending");
  const changes = stepsChanges(steps);
  const running = currentStep(steps);
  const queued = queuedStepIds(steps);
  const groups = foldTaskSteps(steps);
  return (
    <details className="steps" open={open} onToggle={(e) => (e.currentTarget.open !== open ? setManualOpen(e.currentTarget.open) : undefined)}>
      <summary onClickCapture={() => setBuilt(true)}>
        <span className="chev">
          <ChevronRightCompact />
        </span>
        <span className="steps-icon">
          <Tools size={14} />
        </span>
        {pending ? (
          <span>{S.stepsPending(groups.length)}</span>
        ) : !finished ? (
          <span className="steps-working">
            <span>{S.stepsWorking}</span>
            {running && <StepTarget name={running.name} input={running.input} base />}
          </span>
        ) : (
          <span>{live ? S.stepsFinished(groups.length) : S.stepsCompleted(groups.length, durationMs != null ? Math.round(durationMs / 1000) : null)}</span>
        )}
        {changes && finished && <DiffCounts additions={changes.additions} deletions={changes.deletions} title={S.stepsChangesTip} />}
      </summary>
      {showBody && (
        <div className="steps-body">
          {groups.map((group) =>
            group.kind === "tasks" ? <TaskRunRow key={group.key} items={group.items} /> : <StepRow key={group.entry.item.id} item={group.entry.item} permission={group.entry.permission} queued={queued.has(group.entry.item.id)} />,
          )}
        </div>
      )}
    </details>
  );
});

export const TimelineRow = memo(function TimelineRow({ item }: { item: TimelineItem }) {
  const { agentId, improvement = false } = useContext(TimelineContext);
  switch (item.kind) {
    case "user":
      if (item.source === "system") return <AutomatedMessageRow text={item.text} />;
      return (
        <div className="row-user">
          <Markdown className="row-user-text" text={item.text} breaks linkify={false} />
        </div>
      );
    case "assistant":
      return (
        <>
          {item.streaming ? (
            <StreamingMarkdown text={improvement ? withoutQuestionMarker(item.text) : item.text} itemId={item.id} />
          ) : (
            <Markdown className="row-assistant" text={improvement ? withoutQuestionMarker(item.text) : item.text} itemId={item.id} breaks media />
          )}
          {mayContainMedia(item.text) && <InlineMedia agentId={agentId} text={improvement ? withoutQuestionMarker(item.text) : item.text} streaming={item.streaming} />}
        </>
      );
    case "restored":
      return <RestoredMarker redoable={item.redoable} chatOnly={item.chatOnly} />;
    case "notice":
      if (item.divider) {
        return (
          <div className="compact-divider" role="separator" aria-label={item.text}>
            <span className="checkpoint-rule" />
            <span>{item.text}</span>
            <span className="checkpoint-rule" />
          </div>
        );
      }
      if (item.openAgentId) {
        const target = item.openAgentId;
        return (
          <button type="button" className="row-result notice-link" onClick={() => openAgent(target)}>
            <span>{item.text}</span>
            <ChevronRightCompact size={12} />
          </button>
        );
      }
      const notice = item.detail ? { text: item.text, fold: item.fold } : shortNotice(item.text, item.fold);
      return (
        <>
          <div className="row-result">{notice.text}</div>
          {item.detail && <OutputBox className="notice-output" text={item.detail} />}
          {notice.fold && (
            <details className="step">
              <summary>
                <StepIcon icon={<Check size={14} />} status="done" />
                <span className="step-verb muted">{notice.fold.label}</span>
              </summary>
              <OutputBox className="notice-output" text={notice.fold.text} />
            </details>
          )}
          <FeedbackRetryRow agentId={agentId} text={item.text} detail={item.detail} />
        </>
      );
    case "error":
      return (
        <div className="row-error">
          {item.text}
          {item.auth && (
            <div className="row-error-hint">
              {S.loginExpiredBefore}<code className="mono">~/.local/bin/claude auth login</code>{S.loginExpiredAfter}
            </div>
          )}
        </div>
      );
    default:
      return null;
  }
});

const NOTICE_LINE_MAX = 120;
function shortNotice(text: string, fold: { label: string; text: string } | undefined) {
  const head = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (fold || (head === text.trim() && head.length <= NOTICE_LINE_MAX)) return { text, fold };
  const short = head.length > NOTICE_LINE_MAX ? `${head.slice(0, NOTICE_LINE_MAX).trimEnd()}…` : head;
  return { text: short, fold: { label: S.noticeFullText, text } };
}

function AutomatedMessageRow({ text }: { text: string }) {
  const view = systemMessageView(text);
  if (!view) return null;
  return (
    <details className="step step-auto">
      <summary>
        <StepIcon icon={<Check size={14} />} status="done" />
        <span className="step-verb muted">{S.stepAutoMessage}</span>
        {view.preview && <span className="step-detail faint">{view.preview}</span>}
        <span className="step-chevron">
          <ChevronDown size={12} />
        </span>
      </summary>
      <div className="step-output">{view.body}</div>
    </details>
  );
}

export function Markdown({ text, className, breaks = false, linkify = true, workspaceId, itemId, media = false, chunk = false, diagrams = true }: { text: string; className: string; breaks?: boolean; linkify?: boolean; workspaceId?: string | null; itemId?: string; media?: boolean; chunk?: boolean; diagrams?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState<SVGSVGElement | null>(null);
  const languagesVersion = useLanguagesVersion();
  const html = useMemo(() => {
    const sanitized = DOMPurify.sanitize(parseMarkdown(text, { breaks }), { ALLOWED_URI_REGEXP: MARKDOWN_URI });
    const withSlack = slackPreviews(media ? hideLocalImages(sanitized) : sanitized, S.slackPreview);
    return heatmapTables(highlightCodeBlocks(diagrams ? mermaidPreviews(withSlack, S.mermaidPreview) : withSlack));
  }, [text, breaks, languagesVersion, media, diagrams]);
  const { workspaceId: timelineWorkspaceId, agentId } = useContext(TimelineContext);
  const sessionWorkspaceId = timelineWorkspaceId ?? null;
  const checkIn = workspaceId === undefined ? sessionWorkspaceId : workspaceId;
  const files = useStore((s) => (checkIn ? s.files[checkIn] : undefined));
  const refVersion = useFileRefVersion();
  const streaming = className.includes("streaming");
  useEffect(() => {
    if (ref.current) linkifySessionRefs(ref.current);
    if (linkify && ref.current) linkifyElement(ref.current);
    else if (ref.current) {
      for (const anchor of ref.current.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        anchor.target = "_blank";
        anchor.rel = "noreferrer";
      }
    }
  }, [html, linkify]);
  useEffect(() => {
    if (ref.current) addCodeCopyButtons(ref.current, S.copyResponse, S.copiedResponse);
    if (ref.current) addSlackCopyButtons(ref.current, S.slackCopy, S.copiedResponse);
    if (ref.current) addMermaidButtons(ref.current, { expand: S.mermaidExpand, showCode: S.mermaidShowCode, hideCode: S.mermaidHideCode, copy: S.copyResponse, copied: S.copiedResponse }, setZoomed);
  }, [html]);
  useEffect(() => {
    const root = ref.current;
    if (!linkify || streaming || !checkIn || !root) return;
    let stale = false;
    void markFileRefs(root, checkIn, () => stale, agentId);
    return () => {
      stale = true;
    };
  }, [html, linkify, streaming, checkIn, files, refVersion, agentId]);
  return (
    <>
      <div className={chunk ? "markdown-chunk" : `markdown ${className}`} ref={ref} data-item-id={itemId} dangerouslySetInnerHTML={{ __html: html }} />
      {zoomed && <MermaidLightbox svg={zoomed} onClose={() => setZoomed(null)} />}
    </>
  );
}

export function StreamingMarkdown({ text, itemId, className = "row-assistant" }: { text: string; itemId?: string; className?: string }) {
  const chunks = useMemo(() => streamingChunks(text), [text]);
  const lastOpen = endsInsideFence(text);
  return (
    <div className={`markdown ${className} streaming`} data-item-id={itemId}>
      {chunks.map((chunk, index) => (
        <MarkdownChunk key={index} text={chunk} diagrams={!(lastOpen && index === chunks.length - 1)} />
      ))}
    </div>
  );
}

const MarkdownChunk = memo(function MarkdownChunk({ text, diagrams }: { text: string; diagrams: boolean }) {
  return <Markdown className="" text={text} breaks media chunk diagrams={diagrams} />;
});


function AgentResultText({ text }: { text: string }) {
  const { agentId } = useContext(TimelineContext);
  return (
    <>
      <Markdown className="agent-result" text={text} breaks media />
      {mayContainMedia(text) && <InlineMedia agentId={agentId} text={text} streaming={false} />}
    </>
  );
}

const StepRow = memo(function StepRow({ item, permission, queued = false }: { item: TimelineItem; permission: PermissionItem | null; queued?: boolean }) {
  if (item.kind === "thinking") {
    return (
      <details className="step">
        <summary>
          <StepIcon icon={<Spark size={14} />} status="thinking" />
          <span className="step-verb">{S.stepThinking}</span>
          <span className="step-detail muted">{item.text.slice(0, 80)}</span>
        </summary>
        <div className="step-output">{item.text}</div>
      </details>
    );
  }
  if (item.kind === "permission") return <PermissionRow item={item} />;
  if (item.kind !== "tool") return null;
  if (isInteractiveTool(item.name)) return <InteractiveStepRow item={item} permission={permission} />;
  if (permission?.notion && permission.status !== "pending") return <NotionWriteRow tool={item} permission={permission} />;
  if (isTaskTool(item.name) && !permission) return <TaskStepRow item={item} />;
  if (isAgentTool(item.name) && item.task) return <AgentStepRow item={item} permission={permission} renderStep={(step) => <StepRow key={step.id} item={step} permission={null} />} renderText={(text) => <AgentResultText text={text} />} />;
  const verb = item.status === "done" && createdNewFile(item.name, item.output) ? S.verbCreated : describeTool(item.name).verb;
  const gate = permission?.status === "pending" ? "pending" : permission?.status === "denied" ? "denied" : null;
  const isBash = item.name === "Bash";
  const running = item.status === "running" && !gate && !queued;
  const shownVerb = gate === "denied" ? S.stepSkipped : gate === "pending" || queued ? (S.verbsBase[item.name as keyof typeof S.verbsBase] ?? verb) : running && isBash ? S.stepRunning : verb;
  const changes = gate === "denied" || item.status === "error" ? null : toolChanges(item.name, item.input);
  const state = gate === "denied" ? "denied" : gate === "pending" ? "running" : queued ? "queued" : item.status;
  if (isAsideTool(item.name)) return <AsideStepRow item={item} state={state} gate={gate} queued={queued} />;
  const command = typeof item.input.command === "string" ? item.input.command : "";
  const readFailed = item.name === "Read" && item.status === "error" && !item.cancelled && gate === null;
  const browserLabel = isBrowserTool(item.name) ? browserToolLabel(item.name, item.input, item.page?.title ?? browserPageTitle(typeof item.input.pageId === "string" ? item.input.pageId : null), item.status === "running" || gate !== null ? "running" : "done") : null;
  return (
    <>
    <details className="step" data-tool={item.name} data-status={state} data-cancelled={item.cancelled || undefined}>
      <summary>
        <StepIcon icon={<ToolGlyph name={item.name} input={item.input} />} status={item.cancelled || gate === "denied" ? "cancelled" : state === "running" ? "running" : item.status === "error" ? "error" : "done"} />
        {readFailed ? (
          <span className="step-verb">{S.readFailed}</span>
        ) : browserLabel ? (
          <>
            <span className="step-verb">{gate === "denied" ? S.stepSkipped : browserLabel.verb}</span>
            {gate !== "denied" && browserLabel.page && <BrowserPageChip title={browserLabel.page} />}
            {gate !== "denied" && browserLabel.after && <span className="step-verb">{browserLabel.after}</span>}
          </>
        ) : (
          <>
            <span className="step-verb">{shownVerb}</span>
            <StepTarget name={item.name} input={item.input} changes={changes && (changes.additions > 0 || changes.deletions > 0) ? changes : null} />
          </>
        )}
        {gate === "pending" && <span className="faint xs">{S.stepWaiting}</span>}
        {queued && <span className="faint xs">{S.stepQueued}</span>}
        {!gate && item.status === "error" && !item.cancelled && !isBash && !readFailed && <span className="minus xs">{S.stepFailed}</span>}
        {isBash && (
          <span className="step-chevron">
            <ChevronDown size={12} />
          </span>
        )}
      </summary>
      {isBash ? (
        <div className="step-terminal mono">
          <div className="step-terminal-line">
            {running && <DotSpinner size={12} />}
            {item.cancelled && <Codicon name="circle-slash" size={12} className="step-terminal-cancel" />}
            <span>{command}</span>
          </div>
          {item.output && gate !== "denied" && <TerminalOutput text={item.output} />}
        </div>
      ) : (
        item.output && gate !== "denied" && <pre className="step-output mono">{item.output}</pre>
      )}
    </details>
    {item.shots?.map((path) => (
      <ShotThumb key={path} path={path} />
    ))}
    </>
  );
});

function TerminalOutput({ text }: { text: string }) {
  const ref = useTailScroll(text);
  return (
    <pre className="step-terminal-output" ref={ref}>
      {text}
    </pre>
  );
}

function OutputBox({ text, className }: { text: string; className: string }) {
  return (
    <div className={`step-terminal mono ${className}`}>
      <TerminalOutput text={text} />
    </div>
  );
}

function useTailScroll(text: string) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return ref;
}

const isBrowserTool = (name: string) => name.startsWith(BROWSER_TOOL_PREFIX);

function BrowserPageChip({ title }: { title: string }) {
  return (
    <span className="page-chip" title={title}>
      <Codicon name="globe" size={12} />
      <span className="page-chip-name">{title}</span>
    </span>
  );
}

const shotCache = new Map<string, string | null>();

function ShotThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null | undefined>(shotCache.get(path));
  useEffect(() => {
    if (shotCache.has(path)) return;
    let cancelled = false;
    void rpc.call("browser.readShot", { path }).then(({ png }) => {
      const url = png ? `data:image/png;base64,${png}` : null;
      shotCache.set(path, url);
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!src) return null;
  return (
    <div className="step-shot">
      <img src={src} alt={S.browserShotAlt} />
    </div>
  );
}

function InteractiveStepRow({ item, permission }: { item: Extract<TimelineItem, { kind: "tool" }>; permission: PermissionItem | null }) {
  const step = interactiveStep(item.name, item.input, permission, item.status !== "running", {
    asked: S.verbs.AskUserQuestion,
    ask: S.verbsBase.AskUserQuestion,
    skipped: S.questionSkipped,
    planApproved: S.planApprovedStep,
    planKept: S.planKeptStep,
    planWaiting: S.planWaitingStep,
    feedback: S.planFeedbackLabel,
    after: (mode) => S.planAfterNote(S.permissionModes[mode]),
  });
  return (
    <details className="step" data-tool={item.name} data-status={step.state === "pending" ? "running" : item.status}>
      <summary>
        <StepIcon icon={<ToolGlyph name={item.name} input={item.input} />} status={step.state === "pending" ? "running" : step.state === "skipped" ? "cancelled" : "done"} />
        <span className="step-verb">{step.verb}</span>
        {step.detail && <span className="step-detail muted">{step.detail}</span>}
        {step.state === "pending" && <span className="faint xs">{S.stepWaiting}</span>}
      </summary>
      {step.qa.length > 0 && (
        <div className="step-qa">
          {step.qa.map((row) => (
            <div key={row.question} className="step-qa-row">
              <span className="step-qa-question">{row.question}</span>
              <span className="step-qa-answer">{row.answer}</span>
            </div>
          ))}
        </div>
      )}
      {step.note && <div className="step-qa-note">{step.note}</div>}
      {step.plan && step.state !== "pending" && <Markdown className="step-plan" text={step.plan} />}
    </details>
  );
}

const BROWSER_GLYPHS: Record<string, string> = {
  open_browser_page: "open-in-product",
  click_element: "cursor",
  drag_element: "move",
  handle_dialog: "comment",
  hover_element: "cursor",
  navigate_page: "arrow-right",
  read_page: "file-text",
  run_playwright_code: "terminal",
  screenshot_page: "device-camera",
  type_in_page: "symbol-text",
  list_browser_pages: "globe",
  read_console_logs: "output",
};

function ToolGlyph({ name, input }: { name: string; input?: Record<string, unknown> }) {
  if (name.startsWith(BROWSER_TOOL_PREFIX)) {
    const id = name.slice(BROWSER_TOOL_PREFIX.length);
    const nav = id === "navigate_page" ? (input?.type ?? input?.action) : null;
    return <Codicon name={nav === "back" ? "arrow-left" : nav === "reload" ? "refresh" : (BROWSER_GLYPHS[id] ?? "tools")} size={14} />;
  }
  if (isAsideTool(name)) return <Codicon name="globe" size={14} />;
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") return <Edit size={14} />;
  if (name === "Bash") return <TerminalCompact size={14} />;
  if (name === "Read" || name === "Grep" || name === "Glob") return <BookCompact size={14} />;
  return <Tools size={14} />;
}

function StepIcon({ icon, status }: { icon: ReactNode; status: "running" | "done" | "error" | "thinking" | "cancelled" }) {
  return <span className="step-icon">{status === "cancelled" || status === "error" ? <Codicon name="error" size={14} /> : icon}</span>;
}

function StepTarget({ name, input, base, changes = null }: { name: string; input: Record<string, unknown>; base?: boolean; changes?: { additions: number; deletions: number } | null }) {
  const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (filePath) {
    const ref: FileRef & { search?: string } = { raw: filePath };
    if (name === "Read" && typeof input.offset === "number") ref.line = input.offset;
    if (name === "Edit" && typeof input.new_string === "string" && input.new_string.trim()) ref.search = input.new_string.slice(0, 300);
    return <FileChip path={filePath} data={ref} changes={changes} />;
  }
  const { detail } = describeTool(name, input);
  const verb = base ? (S.verbsBase[name as keyof typeof S.verbsBase] ?? name) : null;
  return (
    <>
      {verb && <span className="step-verb">{verb}</span>}
      {detail && <code className="code-chip">{detail}</code>}
    </>
  );
}

function FileChip({ path, data, changes = null }: { path: string; data: FileRef; changes?: { additions: number; deletions: number } | null }) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <span className="file-chip" data-file={JSON.stringify(data)} title={path}>
      <FileTypeIcon name={name} />
      <span className="file-chip-name">{name}</span>
      {changes && <DiffCounts additions={changes.additions} deletions={changes.deletions} />}
    </span>
  );
}

function PermissionRow({ item }: { item: PermissionItem }) {
  if (item.status === "pending") return null;
  if (item.notion) return <NotionWriteRow tool={null} permission={item} />;
  const { detail } = describeTool(item.toolName, item.input);
  const filePath = typeof item.input.file_path === "string" ? item.input.file_path : null;
  return (
    <div className="step" data-status={item.status}>
      <div className="step-line" data-status={item.status}>
        <StepIcon icon={<Check size={14} />} status={item.status === "allowed" ? "done" : "cancelled"} />
        <span className="step-verb">{item.toolName}</span>
        <span className="step-detail muted">{filePath ? shortPath(filePath) : detail}</span>
        <span className="faint xs">{item.status === "allowed" ? S.permissionAllowed : S.permissionDenied}</span>
      </div>
    </div>
  );
}

function describeTool(name: string, input: Record<string, unknown> = {}): { verb: string; detail: string | null } {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  switch (name) {
    case "Bash":
      return { verb: S.verbs.Bash, detail: (str("command") ?? "").split("\n")[0].slice(0, 120) };
    case "Read":
      return { verb: S.verbs.Read, detail: null };
    case "Edit":
    case "MultiEdit":
      return { verb: S.verbs.Edit, detail: null };
    case "Write":
      return { verb: S.verbs.Write, detail: null };
    case "Grep":
      return { verb: S.verbs.Grep, detail: `${str("pattern") ?? ""}${str("path") ? ` in ${shortPath(str("path")!)}` : ""}` };
    case "Glob":
      return { verb: S.verbs.Glob, detail: str("pattern") };
    case "Agent":
    case "Task":
      return { verb: S.verbs.Agent, detail: str("description") ?? str("prompt")?.slice(0, 80) ?? null };
    case "WebFetch":
      return { verb: S.verbs.WebFetch, detail: str("url") };
    case "WebSearch":
      return { verb: S.verbs.WebSearch, detail: str("query") };
    case "Skill":
      return { verb: S.verbs.Skill, detail: str("skill") };
    case "mcp__aside__repl":
      return { verb: S.verbs.mcp__aside__repl, detail: asideTitle(input) || S.asideFallbackTitle };
    default:
      return { verb: name, detail: str("description") ?? str("query") ?? (Object.keys(input).length ? JSON.stringify(input).slice(0, 100) : null) };
  }
}

function browserPageTitle(pageId: string | null): string | null {
  const tabs = getState().tabs.filter((t): t is BrowserTab => t.kind === "browser");
  const tab = pageId ? tabs.find((t) => t.key === pageId) : tabs.filter((t) => t.sharedWith).length === 1 ? tabs.find((t) => t.sharedWith) : undefined;
  return tab ? tab.title || tab.url || null : null;
}

function shortPath(path: string) {
  const parts = path.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}
