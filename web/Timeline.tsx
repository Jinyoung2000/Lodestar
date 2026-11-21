import DOMPurify from "dompurify";
import { parseMarkdown } from "./markdownParse";
import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { streamingChunks } from "./streamingChunks";
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
import { formatBytes } from "../shared/files"; // FILEATTACH
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
import { useLanguagesVersion } from "./languages";
import { BROWSER_TOOL_PREFIX } from "../server/browserToolNames";
import { browserToolLabel } from "./browserToolLabels";
import { rpc } from "./rpc";
import { openNotionScreen } from "./notionScreen"; // NOTION2
import { NotionWriteRow } from "./NotionWriteRow"; // NOTION3
import { AsideStepRow } from "./AsideStepRow"; // ASIDEVIEW
import { InlineMedia } from "./MediaPreview"; // INLINEMEDIA
import { hideLocalImages } from "./mediaHtml"; // INLINEMEDIA
import { mayContainMedia } from "../shared/media"; // INLINEMEDIA
import { asideTitle } from "./asideStep"; // ASIDEVIEW
import { isAsideTool } from "../shared/asideTool"; // ASIDEVIEW
import { getState, openAgent, openChanges, openDiff, openFile, setChangesScope, useStore, type BrowserTab } from "./store";
import { S } from "./strings";
import { createdNewFile, currentStep, foldTaskSteps, formatClock, interactiveStep, modelLabel, queuedStepIds, stepsChanges, systemMessageView, toolChanges, turnFooter, type PermissionItem, type StepEntry, type Turn, type UserItem } from "./timelineModel";
import { isInteractiveTool } from "../shared/interactive";

export { ApprovalCard } from "./Approval";
export { groupTurns, reuseTurns, splitTurns } from "./timelineModel";

// 사용자 메시지 하나와 그 응답들. 말풍선은 이 안에서만 머리 아래에 붙는다(sticky). 시스템이 시작한 턴(user 없음)은 말풍선이 없다.
// memo: 항목이 안 바뀐 턴은 AgentView 가 이전 turn 객체를 그대로 넘겨(reuseTurns) 스트리밍 중에도 마지막 턴만 다시 그려진다.
export const TurnView = memo(function TurnView({ turn, first, last, live }: { turn: Turn; first: boolean; last: boolean; live: boolean }) {
  const { agentId } = useContext(TimelineContext);
  const models = useStore((s) => s.meta?.models);
  const { assistant, result, text } = turnFooter(turn);
  // 응답이 아직 오는 중이면 아래 줄을 달지 않는다.
  const showFooter = assistant && (!live || result);
  const changes = result?.changes;
  return (
    <div className="turn" data-turn-key={turn.key} data-last={last || undefined}>
      {turn.user && <UserHead user={turn.user} first={first} />}
      {turn.blocks.map((block) => {
        if (block.kind === "item") return block.item.kind === "restored" ? null : <TimelineRow key={block.item.id} item={block.item} />;
        // 단계가 하나면 묶음 없이 그 단계 한 줄만 보인다. 승인을 기다리는 단계는 입력창 위 카드와 "1 confirmation pending" 이 맡는다.
        // 연속된 할 일 호출이 한 줄로 접혀 한 줄만 남는 경우도 같다.
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

// 응답 아래 `N files changed`: 눌러서 그 턴이 바꾼 파일을 그 자리에 펼치고, 파일 행을 누르면 그 파일의 diff 탭을 연다.
// 파일 목록 없이 저장된 옛 턴은 Last Turn 범위로 변경 패널을 여는 버튼으로 남는다.
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

// 말풍선과 그 오른쪽 위 체크포인트 단추. 스크롤하면 말풍선이 머리 아래에 붙고, 붙어 있는 동안은 두 줄까지만 보인다.
const UserHead = memo(function UserHead({ user, first }: { user: UserItem; first: boolean }) {
  // CODEX: Codex 세션은 체크포인트 복원과 갈래가 없다(2단계)
  const { codex, locked } = useContext(TimelineContext);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // 감시선이 스크롤 영역 위로 지나가면 말풍선이 붙은 상태다. 접힘이 스크롤 위치를 바꿔 판정을 뒤집지 않게 판정 경계를 물려 둔다(web/stuckBubble.ts).
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
        {/* DIFFFB: 피드백만 보낸 메시지는 글이 없다. 빈 말풍선 대신 칩만 둔다. */}
        {(user.shown !== "" || !user.attachments?.length) && (
          <div className="row-user">
            <Markdown className="row-user-text" text={user.shown ?? user.text} breaks linkify={false} />
          </div>
        )}
      </div>
    </>
  );
});

// 보낸 메시지에 붙은 첨부(피드백에서 고른 화면 요소). 소스 위치가 있으면 누르면 그 세션 작업 폴더의 파일 줄로 열린다.
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

// FILEATTACH: 보낸 메시지에 붙은 파일 칩(아이콘, 이름, 크기). 파일 내용은 모델에 가지 않고 경로만 갔다. 마우스를 올리면 그 경로가 보인다.
function FileBubbleChip({ attachment }: { attachment: Extract<UserAttachment, { kind: "file" }> }) {
  return (
    <span className="user-attachment user-attachment-file mono" title={attachment.path}>
      <Codicon name="file" size={12} />
      <span className="user-attachment-name">{attachment.label}</span>
      <span className="user-attachment-where">{formatBytes(attachment.bytes)}</span>
    </span>
  );
}

// NOTION2: 페이지 전용 대화의 첫 메시지에 붙은 Notion 페이지 칩. 누르면 그 페이지의 Notion 화면으로 간다.
function NotionBubbleChip({ label, url }: { label: string; url: string }) {
  return (
    <button type="button" className="user-attachment" title={url} onClick={() => openNotionScreen(url)}>
      <Codicon name="file" size={12} />
      <span className="user-attachment-name">{label}</span>
    </button>
  );
}

// 피드백에 붙은 창 스크린샷. 모델이 본 화면의 작은 썸네일이다.
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

// CODEX: Codex 턴은 비용 대신 토큰 수를 준다
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

// 승인을 기다리는 호출은 입력창 위 카드가 맡고, 대화에는 이 한 줄만 남는다.
export function PendingNotice({ count }: { count: number }) {
  return (
    <div className="thinking-indicator" role="status">
      <DotSpinner state="waiting" size={14} />
      <span>{S.confirmationsPending(count)}</span>
    </div>
  );
}

export const StepsBlock = memo(function StepsBlock({ steps, finished, durationMs, live }: { steps: StepEntry[]; finished: boolean; durationMs: number | null; live: boolean }) {
  // Settings 의 Expand tool steps 가 켜져 있으면 실행 중이든 끝났든 열어 둔다. 기본(꺼짐)은 접힌 채로 두고 사용자가 연 묶음만 열린다(사용자 10-20).
  // 사용자가 손으로 접거나 편 묶음은 설정이 바뀌어도 그 값을 지킨다. 이 상태는 묶음이 화면에서 사라질 때(세션 화면을 떠날 때) 같이 사라진다.
  const expandSteps = useStore((s) => s.settings?.expandSteps === true);
  const { revealAll } = useContext(TimelineContext);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? expandSteps;
  // 접힌 묶음은 열기 전에는 안쪽 줄을 만들지 않는다(긴 대화의 DOM 노드 대부분이 여기 있다). 한 번 만든 줄은 다시 접어도 남긴다.
  // 요약 줄을 누르면 클릭 처리 안에서 먼저 만들어, 열린 첫 프레임에 빈 상자가 보이지 않게 한다.
  const [built, setBuilt] = useState(false);
  const showBody = built || revealAll || manualOpen === true || (manualOpen === null && expandSteps);
  if (showBody && !built) setBuilt(true);
  const pending = steps.some(({ item, permission }) => (item.kind === "permission" ? item : permission)?.status === "pending");
  const changes = stepsChanges(steps);
  const running = currentStep(steps);
  const queued = queuedStepIds(steps);
  // 머리의 단계 수는 접은 뒤 펼쳤을 때 보이는 줄 수다(할 일 호출 여러 개가 한 줄이면 한 단계로 센다).
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
  // 개선 세션이 질문 앞에 붙이는 [QUESTION] 표지는 보이지 않는다.
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
          {/* INLINEMEDIA: 글에 이미지나 영상 경로가 있을 때만 미리보기 줄을 만든다 */}
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
      // HANDOFF: "Handed off to ..." 줄은 누르면 넘겨받은 세션으로 간다
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

// fix5-2: 시스템이 넣은 사용자 턴(압축 요약, 백그라운드 작업 알림, 훅 피드백). 내용이 없으면 줄을 만들지 않고, 있으면 첫 줄 미리보기와 펼침 화살표를 보인다.
// 서버가 긴 알림(백그라운드 작업 결과 등)을 한 줄로 줄이고 전체를 접기 전에 저장된 항목도 같은 모양으로 보인다
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

// itemId: 대화 항목 id. 카드에서 이 메시지로 스크롤하고(web/toBoardState.ts) 글을 드래그했을 때 어느 메시지인지 알아내는 데 쓴다.
// breaks: 줄바꿈을 그대로 보인다(사용자 메시지와 응답 글. 응답 속 "• " 줄 목록이 한 문단으로 붙지 않게). linkify: 응답 속 파일 경로만 링크로 바꾼다(사용자 메시지는 안 바꾼다).
// media: 응답 글이다. `![](로컬 경로)` 의 깨진 그림 대신 대체 글을 보인다(그림은 글 아래 InlineMedia 가 보인다).
// workspaceId: 파일 링크가 가리키는 파일이 있는지 확인할 폴더. 없으면 타임라인의 세션 폴더, 둘 다 없으면 확인하지 않는다(null 은 폴더 없음).
// chunk: 응답 중인 글의 한 조각(StreamingMarkdown 이 쓴다). 겉 div.markdown 안에 display: contents 로 들어가 레이아웃에는 끼지 않는다.
export function Markdown({ text, className, breaks = false, linkify = true, workspaceId, itemId, media = false, chunk = false }: { text: string; className: string; breaks?: boolean; linkify?: boolean; workspaceId?: string | null; itemId?: string; media?: boolean; chunk?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const languagesVersion = useLanguagesVersion();
  const html = useMemo(() => {
    const sanitized = DOMPurify.sanitize(parseMarkdown(text, { breaks }), { ALLOWED_URI_REGEXP: MARKDOWN_URI });
    return heatmapTables(highlightCodeBlocks(slackPreviews(media ? hideLocalImages(sanitized) : sanitized, S.slackPreview)));
  }, [text, breaks, languagesVersion, media]);
  const { workspaceId: timelineWorkspaceId, agentId } = useContext(TimelineContext);
  const sessionWorkspaceId = timelineWorkspaceId ?? null;
  const checkIn = workspaceId === undefined ? sessionWorkspaceId : workspaceId;
  // 파일 목록이 새로 오거나 존재 캐시가 버려지면(파일 생성, 바깥 변경) 링크를 다시 확인한다.
  const files = useStore((s) => (checkIn ? s.files[checkIn] : undefined));
  const refVersion = useFileRefVersion();
  const streaming = className.includes("streaming");
  // 세션 참조는 사용자 메시지(linkify 꺼짐)에서도 누를 수 있어야 해서 파일 링크보다 먼저, 항상 바꾼다. href 가 지워진 앵커는 파일 링크 처리가 건드리지 않는다.
  useEffect(() => {
    if (ref.current) linkifySessionRefs(ref.current);
    if (linkify && ref.current) linkifyElement(ref.current);
    else if (ref.current) {
      // 파일 링크로 바꾸지 않는 글(사용자 메시지, 대기 메시지)의 링크도 새 창으로 연다. target 이 없으면 누르는 순간 앱 창이 그 주소로 옮겨 간다.
      for (const anchor of ref.current.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        anchor.target = "_blank";
        anchor.rel = "noreferrer";
      }
    }
  }, [html, linkify]);
  useEffect(() => {
    if (ref.current) addCodeCopyButtons(ref.current, S.copyResponse, S.copiedResponse);
    if (ref.current) addSlackCopyButtons(ref.current, S.slackCopy, S.copiedResponse);
  }, [html]);
  // 글이 아직 흘러나오는 중에는 확인하지 않는다(쓰다 만 경로가 없는 파일로 깜박이지 않게).
  useEffect(() => {
    const root = ref.current;
    if (!linkify || streaming || !checkIn || !root) return;
    let stale = false;
    void markFileRefs(root, checkIn, () => stale, agentId);
    return () => {
      stale = true;
    };
  }, [html, linkify, streaming, checkIn, files, refVersion, agentId]);
  return <div className={chunk ? "markdown-chunk" : `markdown ${className}`} ref={ref} data-item-id={itemId} dangerouslySetInnerHTML={{ __html: html }} />;
}

// 응답 중인 글. 빈 줄로 끝난 문단(코드 블록 안의 빈 줄은 빼고)은 조각으로 굳혀 두고 자라는 마지막 조각만 다시 파싱하고 그린다.
// 응답 글은 토큰이 올 때마다 전체가 다시 와서, 통째로 그리면 긴 답일수록 갱신마다 파싱, 정리(DOMPurify), 코드 강조, innerHTML 교체가 답 전체 몫으로 든다(PERF2).
// 문단을 나눠 그리면 목록 사이 빈 줄이나 뒤에서 정의되는 참조 링크가 잠깐 다르게 보일 수 있다. 응답이 끝나면(streaming 이 꺼지면) 행이 전체를 한 번에 그리는 Markdown 으로 돌아간다.
function StreamingMarkdown({ text, itemId }: { text: string; itemId: string }) {
  const chunks = useMemo(() => streamingChunks(text), [text]);
  return (
    <div className="markdown row-assistant streaming" data-item-id={itemId}>
      {chunks.map((chunk, index) => (
        <MarkdownChunk key={index} text={chunk} />
      ))}
    </div>
  );
}

// 굳은 조각은 글이 같으면 다시 그리지 않는다.
const MarkdownChunk = memo(function MarkdownChunk({ text }: { text: string }) {
  return <Markdown className="" text={text} breaks media chunk />;
});


// INLINEMEDIA: 서브에이전트가 돌려준 결과 글. 응답 글과 같이 이미지와 영상 경로의 미리보기를 붙인다.
function AgentResultText({ text }: { text: string }) {
  const { agentId } = useContext(TimelineContext);
  return (
    <>
      <Markdown className="agent-result" text={text} breaks media />
      {mayContainMedia(text) && <InlineMedia agentId={agentId} text={text} streaming={false} />}
    </>
  );
}

// 단계 한 줄 요약: 아이콘, 동사, 대상(파일 칩이나 명령 칩), 변경량. 명령은 회색 코드 칩으로 자른다.
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
  if (permission?.notion && permission.status !== "pending") return <NotionWriteRow tool={item} permission={permission} />; // NOTION3
  if (isTaskTool(item.name) && !permission) return <TaskStepRow item={item} />;
  // SUB: 서브에이전트를 띄운 호출은 그 서브에이전트의 단계 목록을 품은 줄로 보인다
  if (isAgentTool(item.name) && item.task) return <AgentStepRow item={item} permission={permission} renderStep={(step) => <StepRow key={step.id} item={step} permission={null} />} renderText={(text) => <AgentResultText text={text} />} />;
  const verb = item.status === "done" && createdNewFile(item.name, item.output) ? S.verbCreated : describeTool(item.name).verb;
  // 승인 대기와 거절은 아직 일어나지 않았거나 일어나지 않을 일이라 과거형("Edited") 대신 원형 동사를 쓴다.
  const gate = permission?.status === "pending" ? "pending" : permission?.status === "denied" ? "denied" : null;
  const isBash = item.name === "Bash";
  // fix5-2: 앞의 승인이 끝나야 시작하는 호출은 돌고 있는 것이 아니라 줄 서 있는 것이다
  const running = item.status === "running" && !gate && !queued;
  const shownVerb = gate === "denied" ? S.stepSkipped : gate === "pending" || queued ? (S.verbsBase[item.name as keyof typeof S.verbsBase] ?? verb) : running && isBash ? S.stepRunning : verb;
  const changes = gate === "denied" || item.status === "error" ? null : toolChanges(item.name, item.input);
  const state = gate === "denied" ? "denied" : gate === "pending" ? "running" : queued ? "queued" : item.status;
  // ASIDEVIEW: Aside 호출은 제목, 주소, 결과 미리보기, 코드, 이미지를 보이는 전용 행이다
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

// 명령 상자 안의 출력. 최대 높이를 넘으면 상자 안에서 스크롤하고, 끝부분(결과와 오류)이 보이게 맨 아래에서 시작한다.
function TerminalOutput({ text }: { text: string }) {
  const ref = useTailScroll(text);
  return (
    <pre className="step-terminal-output" ref={ref}>
      {text}
    </pre>
  );
}

// 상자 하나로 보이는 긴 출력(검사 로그 등). 명령 줄 없이 출력만.
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

// fixB: 질문과 계획 승인 단계. 답하기 전에는 대기 한 줄, 답한 뒤에는 질문과 고른 답(또는 계획과 결정)이 펼침 안에 남는다.
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

// 단계 아이콘: 도구 아이콘이 기본, 진행 중과 실패는 색으로, 중단과 건너뜀은 ⊗ 로.
function StepIcon({ icon, status }: { icon: ReactNode; status: "running" | "done" | "error" | "thinking" | "cancelled" }) {
  return <span className="step-icon">{status === "cancelled" || status === "error" ? <Codicon name="error" size={14} /> : icon}</span>;
}

// 도구 호출의 대상: 파일이면 칩(언어 배지와 이름), 아니면 명령이나 요약. base 는 라벨용으로 동사 없이 대상만 그린다.
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

// 도구 호출과 짝이 없는 승인 요청(이전 버전이 남긴 타임라인 등). 대기 중인 것은 입력창 위 카드와 "N confirmation pending" 이 맡는다.
function PermissionRow({ item }: { item: PermissionItem }) {
  if (item.status === "pending") return null;
  if (item.notion) return <NotionWriteRow tool={null} permission={item} />; // NOTION3
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
    // ASIDEVIEW: 묶음 머리 "Working: Browser <제목>" 에 보이는 대상
    case "mcp__aside__repl":
      return { verb: S.verbs.mcp__aside__repl, detail: asideTitle(input) || S.asideFallbackTitle };
    default:
      return { verb: name, detail: str("description") ?? str("query") ?? JSON.stringify(input).slice(0, 100) };
  }
}

// 에이전트의 Browser 도구 입력이 가리키는 탭의 제목. pageId 가 없으면 공유된 탭이 하나일 때 그것이다.
function browserPageTitle(pageId: string | null): string | null {
  const tabs = getState().tabs.filter((t): t is BrowserTab => t.kind === "browser");
  const tab = pageId ? tabs.find((t) => t.key === pageId) : tabs.filter((t) => t.sharedWith).length === 1 ? tabs.find((t) => t.sharedWith) : undefined;
  return tab ? tab.title || tab.url || null : null;
}

function shortPath(path: string) {
  const parts = path.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}
