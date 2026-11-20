import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { defaultChangeScope, type Agent, type EffortLevel, type FileRef, type ImageRef, type PermissionMode } from "../shared/protocol";
import { AttachMenu } from "./AttachMenu";
import { changesChipTitle, openSessionChanges } from "./changesChip";
import { useChangesView } from "./changesState";
import { ComposerFeedback } from "./DiffFeedbackChips";
import { pendingOf, sendDiffFeedback, useDiffFeedback } from "./diffFeedbackState";
import { applyMention, applyTrigger, continueMarkdown, draftKey, findTrigger, getDraft, historyOf, removeMention, setDraft, stepHistory } from "./composerState";
import { selectionOf } from "./attachments";
import { nameTails, chipTitle } from "./attachDedupe";
import { useFlashingAttachment } from "./attachFlash";
import { clipboardImageFiles, dragHasFiles, uploadImages } from "./imageAttach";
import { addDropped, addFiles, fileRefsOf, removeFileChip } from "./fileAttach"; // FILEATTACH
import { formatBytes } from "../shared/files";
import { browserAttachmentLabel, formatBrowserAttachment } from "./browserAttach";
import { AddCompact, ArrowUpCompact, Codicon, DiffMultiple, ModelIcon, Stop } from "./icons";
import { nextPermissionMode, PermissionRow } from "./PermissionMenu";
import { PullRequestsChip } from "./PullRequestsChip";
import { HandoffComposerChip } from "./HandoffChip";
import { ContextGauge } from "./ContextGauge";
import { SubagentsChip } from "./Subagents";
import { TasksChip } from "./Tasks";
import { rpc } from "./rpc";
import { pendingToolApproval } from "./approvalKeys";
import { addAttachment, clearAttachmentsByKey, flash, getState, NO_ATTACHMENTS, openChanges, openSide, removeAttachment, refreshGit, refreshPrs, setState, useStore, type Attachment, type FileAttachment } from "./store";
import { startRename } from "./sessionListState";
import { TriggerMenu, useTriggerItems, type TriggerItem } from "./TriggerMenu";
import { attachNotionPage } from "./notionAttach";
import { modelName } from "./timelineModel";
import { Close } from "./icons";
import { interruptAgent } from "./sessionActions";
import { lastPending } from "./pendingMessages"; // QUEUECANCEL
import { editPending } from "./Queue"; // QUEUECANCEL
import { currentDefaults, sideChatModel, useDefaults } from "./defaults";
import { builtinEffort, supportedLevels } from "./effortLevels";
import { S } from "./strings";
import { hint } from "./hint";
import { CODEX_MODE_NOTES } from "../shared/codexPermission"; // CODEX
import { codexModelChip, useCodexMeta, usePaneHarness } from "./harness"; // CODEX
import { continueMarkdown as continueMarkdownEdit, indentMarkdown, type MarkdownEdit } from "./composerMarkdown";

export { PERMISSION_MODES } from "./PermissionMenu";


type ComposerProps = {
  paneId: string;
  // 세션이 있으면 그 세션의 입력창, 없으면 새 세션 화면의 입력창
  agent: Agent | null;
  // 폴더 없는 세션(퀵 챗)이면 null. 파일 첨부와 @ 파일 목록이 없다.
  workspaceId: string | null;
  // 응답 중이어도 입력은 열려 있다. 응답 중에 보낸 메시지는 큐에 들어가고(Enter, 설정에 따라 반대), ⌥Enter 는 반대 동작이다.
  busy: boolean;
  permissionMode: PermissionMode;
  onPermissionMode: (mode: PermissionMode) => void;
  model: string | null;
  activeModel: string | null;
  effort: EffortLevel | null;
  // B3: 입력창 아래 줄(새 세션 화면의 위치와 브랜치 선택). 오른쪽 끝에 붙고, 없으면 줄 자체가 없다.
  footerRight?: ReactNode;
  // B2: 입력창 바로 위에 붙는 승인 카드 자리
  approval?: ReactNode;
  // shown 은 사용자가 입력창에 쓴 글, handoff 는 붙은 인계 문서(prompt 에는 그 문서가 들어 있다), images 는 서버에 올린 이미지(prompt 가 비어 있어도 이미지만 보낼 수 있다), files 는 경로만 모델에 가는 파일(FILEATTACH)
  onSubmit: (prompt: string, options: { steer: boolean; shown?: string; handoff?: { sourceId: string; id: string }; images?: ImageRef[]; files?: FileRef[] }) => Promise<unknown>;
  // 새 세션 화면에서 ⌥Enter. 화면은 그대로 두고 새 세션을 뒤에서 시작한다.
  onSubmitBackground?: (prompt: string, images?: ImageRef[], files?: FileRef[]) => Promise<unknown>;
  // false 를 돌려주면 보내지 않고 입력을 그대로 둔다(새 worktree 세션의 빈 브랜치 이름 등). 안내와 포커스는 호출한 쪽이 한다.
  beforeSubmit?: () => boolean;
};

// memo: 세션 칸은 응답 이벤트마다 다시 그려지지만 입력창 props 는 그대로라 건너뛴다(AgentView 가 콜백과 승인 카드를 고정해 넘긴다, PERF2).
export const Composer = memo(function Composer({ paneId, agent, workspaceId, busy, permissionMode, onPermissionMode, model, activeModel, effort, footerRight, approval, onSubmit, onSubmitBackground, beforeSubmit }: ComposerProps) {
  const storageKey = draftKey(agent?.id ?? null, paneId);
  const [text, setTextState] = useState(() => getDraft(storageKey));
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [triggerIndex, setTriggerIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  // fixB: 이미지를 끌어 오는 중
  const [dropping, setDropping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // FIX6C: 첨부는 초안 글과 같은 키(세션 id 또는 new:<칸 id>)로 읽는다
  const attachments = useStore((s) => s.attachments[storageKey] ?? NO_ATTACHMENTS);
  // ATTACH-DEDUPE: 이름이 같은 다른 파일 칩에 붙일 상위 폴더 꼬리, 이미 있어서 다시 붙지 않은 칩의 강조
  const workspaces = useStore((s) => s.workspaces);
  const nameTail = useMemo(() => nameTails(attachments, (id) => workspaces.find((w) => w.id === id)?.dir), [attachments, workspaces]);
  const flashing = useFlashingAttachment();
  // DIFFFB: diff 줄에 쌓아 둔 피드백. 있으면 보낼 때 입력창 글과 함께 한 메시지로 간다.
  const feedback = pendingOf(useDiffFeedback(agent?.id));
  const focusRequest = useStore((s) => (s.focusComposer?.paneId === paneId ? s.focusComposer.nonce : null));
  const prefill = useStore((s) => s.composerPrefill[paneId]);
  const action = useStore((s) => (s.composerAction?.paneId === paneId ? s.composerAction : null));
  const meta = useStore((s) => s.meta);
  // CODEX: 이 입력창이 Codex 세션(또는 Codex 를 고른 새 세션 화면)의 것이면 모델, effort, 권한 칩이 Codex 쪽 값을 보인다
  const harness = usePaneHarness(paneId, agent);
  const codexMeta = useCodexMeta(harness);
  // 입력창 칩은 패널의 범위 선택과 무관하게 이 세션이 만든 변경(Session 범위)만 센다. 같은 저장소의 다른 세션 변경이 섞이지 않는다.
  const sessionChanges = useStore((s) => (agent ? s.sessionChanges[agent.id] : undefined));
  const branch = useStore((s) => (agent ? (s.gitInfo[agent.id]?.branch ?? null) : null));
  const panelScope = useChangesView((s) => (agent ? (s.scope[agent.id] ?? defaultChangeScope(agent)) : "branch"));
  const defaults = useDefaults();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  const setText = (next: string) => {
    setTextState(next);
    setDraft(storageKey, next);
  };

  useEffect(() => {
    if (focusRequest != null) textareaRef.current?.focus();
  }, [focusRequest]);
  // 보드 카드의 Start Session 이나 큐의 Edit 이 채우는 글. 같은 nonce 는 한 번만 넣어서 사용자가 지운 글이 되살아나지 않는다.
  const appliedPrefill = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || appliedPrefill.current === prefill.nonce) return;
    appliedPrefill.current = prefill.nonce;
    setTextState((current) => {
      const next = prefill.append && current.trim() ? `${current}\n${prefill.text}` : prefill.text;
      setDraft(storageKey, next);
      return next;
    });
    // 한 번 넣었으면 기록을 지운다. 같은 칸이 세션 화면으로 바뀌며 다시 만들어질 때 옛 초안이 되살아나지 않게.
    setState((s) => {
      const { [paneId]: _used, ...rest } = s.composerPrefill;
      return { composerPrefill: rest };
    });
  }, [prefill, paneId, storageKey]);
  // ⌘/ 첨부 선택창(묶음 5 가 composerAction 으로 요청). 다시 만들어질 때 옛 요청을 되살리지 않는다.
  const handledAction = useRef<number | null>(getState().composerAction?.nonce ?? null);
  useEffect(() => {
    if (!action || handledAction.current === action.nonce) return;
    handledAction.current = action.nonce;
    setAttachOpen(true);
  }, [action]);
  useEffect(() => {
    if (!agent) return;
    if (!getState().gitChanges[agent.id]) void refreshGit(agent.id);
    if (!getState().prs[agent.id]) void refreshPrs(agent.id);
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 편집기는 내용만큼 커지고(상한은 CSS), 기본 높이 아래로는 줄지 않는다.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const found = useMemo(() => findTrigger(text, caret), [text, caret]);
  const trigger = found && found.start !== dismissedAt ? found : null;
  const items = useTriggerItems(trigger, workspaceId, agent !== null, harness);
  const menuOpen = trigger !== null && items.length > 0;
  useEffect(() => setTriggerIndex(0), [trigger?.kind, trigger?.query]);

  // 보낸 글과 첨부만 비운다. 이미지를 올리는 동안 이어서 쓴 글이나 새로 붙인 첨부까지 지우면 다음 메시지가 말없이 사라진다.
  const reset = (sentText: string, sentIds: ReadonlySet<string>) => {
    setTextState((current) => {
      const next = current === sentText ? "" : current.startsWith(sentText) ? current.slice(sentText.length).replace(/^\s+/, "") : current;
      setDraft(storageKey, next);
      return next;
    });
    setHistoryIndex(null);
    setCaret(0);
    clearAttachmentsByKey(storageKey, sentIds);
  };
  // 입력과 첨부는 보내기가 성공한 뒤에만 비운다. 실패하면 그대로 남아 다시 보낼 수 있고, 진행 중에는 같은 글이 두 번 가지 않게 막는다.
  // pending 은 요청이 끝날 때까지 입력창 위쪽 진행 막대를 켠다. 새 세션 만들기처럼 응답이 늦어도 보냈다는 걸 알 수 있다.
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const submit = (send: () => Promise<unknown>) => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    const sentText = text;
    const sentIds = new Set(attachments.map((a) => a.id));
    void send()
      .then(() => reset(sentText, sentIds))
      .catch((e: Error) => flash(e.message))
      .finally(() => {
        sending.current = false;
        setPending(false);
      });
  };
  const handoffChip = attachments.find((a) => a.handoff);
  // 인계 문서를 만드는 중에 Enter 를 눌렀으면 만들어지는 즉시 보낸다. 칩이 사라지면(실패나 제거) 예약도 버린다.
  const sendWhenReady = useRef<{ flip: boolean } | null>(null);
  const handoffStatus = handoffChip?.handoff?.status;
  useEffect(() => {
    const queued = sendWhenReady.current;
    if (!queued) return;
    if (handoffStatus === "ready") {
      sendWhenReady.current = null;
      deliver(queued.flip);
    } else if (handoffStatus !== "generating") sendWhenReady.current = null;
  }, [handoffStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const imageChips = attachments.filter((a) => a.image);
  const fileChips = attachments.filter((a) => a.file);
  const compose = () => {
    const prompt = text.trim();
    const parts = attachments.filter((a) => !a.handoff && !a.image && !a.file).map(formatAttachment);
    if (!prompt && !parts.length && !handoffChip && !imageChips.length && !fileChips.length) return feedback.length ? "" : null;
    // 인계 문서가 붙어 있으면 문서가 먼저, 그 뒤에 사용자의 글(없으면 이어서 하라는 한 줄)이 온다
    if (handoffChip) return [formatAttachment(handoffChip), prompt || S.handoffContinue, ...parts].join("\n\n");
    return [prompt, ...parts].filter(Boolean).join("\n\n");
  };
  // "/btw 질문" 은 메인 세션으로 보내지 않고 곁다리 대화를 연다.
  const tryBtw = () => {
    const m = /^\/btw\b\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return false;
    if (!agent) {
      hint(S.btwNeedsSession);
      return true;
    }
    if (harness === "codex") {
      hint(S.codexUnavailable("/btw"));
      return true;
    }
    setText("");
    openSide(agent.id);
    const question = m[1].trim();
    if (question) {
      const side = getState().side;
      if (side) void rpc.call("side.ask", { id: side.id, agentId: agent.id, model: sideChatModel(side.model, agent.model, currentDefaults()), question }).catch((e: Error) => flash(e.message));
    }
    return true;
  };
  // "/rename 새 이름" 은 이 세션의 이름을 바꾼다. 이름이 없으면 사이드바에서 인라인 입력을 연다.
  const tryRename = () => {
    const m = /^\/rename\b\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return false;
    if (!agent) {
      hint(S.renameNeedsSession);
      return true;
    }
    const title = m[1].trim();
    setText("");
    if (title) void rpc.call("agents.rename", { agentId: agent.id, title }).catch((e: Error) => flash(e.message));
    else {
      // Editor 배치에는 앱 사이드바가 없다(startRename 이 대화 패널 머리의 제목을 입력으로 바꾼다)
      if (getState().layoutMode !== "editor") setState({ sidebarOpen: true });
      startRename(agent.id);
    }
    return true;
  };
  // flip 은 ⌥Enter. 새 세션 화면에서는 새 세션을 뒤에서 시작하고, 응답 중인 세션에서는 설정의 기본 동작(queue 나 steer)을 뒤집는다.
  const deliver = (flip: boolean) => {
    if (tryBtw() || tryRename()) return;
    const prompt = compose();
    if (prompt === null) return;
    if (handoffChip?.handoff?.status === "generating") {
      // 문서가 다 만들어지면 아래 effect 가 같은 동작(flip 포함)으로 자동으로 보낸다
      sendWhenReady.current = { flip };
      hint(S.handoffGeneratingBusy);
      return;
    }
    if (agent && feedback.length && !imageChips.length && !fileChips.length) {
      const steer = busy && (defaults.requestQueuing === "steer") !== flip;
      submit(() => sendDiffFeedback(agent.id, prompt, steer));
      return;
    }
    if (!prompt && !imageChips.length && !fileChips.length) return;
    // FILEATTACH: 올리는 중인 파일이 있으면 경로가 아직 없으니 보내지 않고 입력을 그대로 둔다. 실패한 칩은 지우고 다시 붙여야 한다.
    const fileRefs = fileRefsOf(fileChips);
    if ("blocked" in fileRefs) {
      hint(fileRefs.blocked === "uploading" ? S.fileUploading : S.fileUploadFailed);
      return;
    }
    if (beforeSubmit && !beforeSubmit()) return;
    if (!agent && flip && onSubmitBackground) {
      submit(async () => onSubmitBackground(prompt, await uploadImages(imageChips), fileRefs.refs));
      return;
    }
    const steer = busy && (defaults.requestQueuing === "steer") !== flip;
    const handoff = handoffChip?.handoff?.id ? { sourceId: handoffChip.handoff.sourceId, id: handoffChip.handoff.id } : undefined;
    const shown = text.trim();
    submit(async () => {
      const images = await uploadImages(imageChips);
      return onSubmit(prompt, { steer, ...(handoff ? { shown, handoff } : {}), ...(images.length ? { images } : {}), ...(fileRefs.refs.length ? { files: fileRefs.refs } : {}) });
    });
  };

  const chooseTrigger = (item: TriggerItem | undefined) => {
    if (!item || !trigger) return;
    if (item.kind === "command") {
      const next = applyTrigger(text, trigger, `/${item.name} `);
      setText(next.text);
      moveCaret(next.caret);
      return;
    }
    if (item.kind === "notion") {
      // Notion 페이지는 글에 남기지 않고 `@검색어` 만 지운 뒤 본문을 읽어 칩으로 붙인다
      const next = removeMention(text, trigger);
      setText(next.text);
      moveCaret(next.caret);
      void attachNotionPage({ url: item.url, title: item.title, paneId });
      return;
    }
    // fixB: 파일은 글 안의 그 자리에 `@경로` 로 남는다(이중 공백이 생기지 않고 문장이 그대로 읽힌다). 편집기에서 그 파일의 줄 범위를 고른 상태면 줄 범위와 선택한 글이 든 칩으로 붙고 글에서는 `@검색어` 만 지운다.
    const selection = workspaceId ? selectionOf(workspaceId, item.path) : null;
    const next = selection ? removeMention(text, trigger) : applyMention(text, trigger, item.path);
    setText(next.text);
    if (selection) addAttachment(paneId, selection);
    moveCaret(next.caret);
  };
  const moveCaret = (position: number) => {
    setCaret(position);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      el?.focus();
      el?.setSelectionRange(position, position);
    });
  };
  // 마크다운 편집 결과를 입력창에 적용한다. execCommand 로 넣어야 ⌘Z 로 되돌릴 수 있고, 막히면 상태로 직접 바꾼다.
  const applyEdit = (el: HTMLTextAreaElement, edit: MarkdownEdit) => {
    if (edit.insert !== el.value.slice(edit.from, edit.to)) {
      el.setSelectionRange(edit.from, edit.to);
      if (!document.execCommand("insertText", false, edit.insert)) {
        setText(el.value.slice(0, edit.from) + edit.insert + el.value.slice(edit.to));
        setHistoryIndex(null);
        moveCaret(edit.selEnd);
        return;
      }
    }
    el.setSelectionRange(edit.selStart, edit.selEnd);
    setCaret(edit.selStart);
  };
  const browseHistory = (direction: "up" | "down") => {
    const entries = historyOf(agent ? getState().timelines[agent.id] : undefined);
    const next = stepHistory(entries.length, historyIndex, direction);
    setHistoryIndex(next);
    const value = next === null ? "" : entries[next];
    setText(value);
    moveCaret(value.length);
  };

  // fixB: 이미지 붙여넣기(글 없이 이미지만 있을 때), 끌어다 놓기, 선택창에서 고른 파일. FILEATTACH: 끌어다 놓기와 선택창은 이미지가 아닌 파일도 받는다(붙여넣기는 이미지만).
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardImageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void addFiles(paneId, files);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDropping(false);
    void addDropped(paneId, e.dataTransfer);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen && trigger) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setTriggerIndex((i) => (e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        chooseTrigger(items[triggerIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedAt(trigger.start);
        return;
      }
    }
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    const el = e.currentTarget;
    // QUEUECANCEL: 입력이 비어 있고 대기 메시지가 있으면 ↑ 는 마지막 대기 메시지를 거둬 편집으로 불러온다(Claude Code 와 같다). 없으면 아래 입력 기록 넘기기.
    const pending = plain && e.key === "ArrowUp" && text === "" && historyIndex === null && agent ? lastPending(agent) : null;
    if (pending && agent) {
      e.preventDefault();
      void editPending(agent.id, paneId, pending).catch((error: Error) => flash(error.message));
      return;
    }
    // 위 화살표: 입력이 비어 있거나 이미 기록을 넘기는 중이고 커서가 첫 줄일 때. 아래 화살표: 기록을 넘기는 중이고 커서가 마지막 줄일 때.
    if (plain && e.key === "ArrowUp" && (text === "" || historyIndex !== null) && !el.value.slice(0, el.selectionStart).includes("\n")) {
      e.preventDefault();
      browseHistory("up");
      return;
    }
    if (plain && e.key === "ArrowDown" && historyIndex !== null && !el.value.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      browseHistory("down");
      return;
    }
    // 도구 승인 카드가 떠 있으면 ⌘Enter 와 ⌥⌘Enter 는 승인 단축키(web/approvalKeys.ts)의 것이다. 보내지 않고 window 의 keydown 으로 넘긴다.
    if (e.key === "Enter" && e.metaKey && !e.shiftKey && !e.ctrlKey && pendingToolApproval()) return;
    // ⇧Tab 은 Claude Code 처럼 권한 모드를 다음 것으로 돌린다. 목록 안에서도 내어쓰기보다 앞선다.
    if (e.key === "Tab" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onPermissionMode(nextPermissionMode(permissionMode, harness));
      return;
    }
    // 목록과 코드 블록 안에서는 줄바꿈(Shift+Enter)이 항목 표시와 들여쓰기를 잇고, Tab 이 들여쓰기를 바꾼다.
    if (!e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "Tab" || (e.key === "Enter" && e.shiftKey))) {
      const edit = e.key === "Tab" ? indentMarkdown(el.value, el.selectionStart, el.selectionEnd, e.shiftKey) : continueMarkdownEdit(el.value, el.selectionStart, el.selectionEnd);
      if (edit) {
        e.preventDefault();
        applyEdit(el, edit);
        return;
      }
    }
    if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && el.selectionStart === el.selectionEnd && /^\s*>/.test(el.value.slice(el.value.lastIndexOf("\n", el.selectionStart - 1) + 1))) {
      // 인용(`> `)만 여기서 다음 줄로 잇는다. 목록은 위의 composerMarkdown 이 맡는다(막 쓴 "1. " 한 줄을 지우지 않는 규칙이 거기 있다).
      const next = continueMarkdown(el.value, el.selectionStart);
      if (next) {
        e.preventDefault();
        setText(next.text);
        setHistoryIndex(null);
        moveCaret(next.caret);
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    deliver(e.altKey);
  };

  // 칩 툴팁. 모델 라벨이 숨는 좁은 폭에서 이름을 알려 주므로 칩 위에 즉시 띄운다.
  const toolsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; left: number } | null>(null);
  const showTip = (text: string, chip: HTMLElement) => {
    const row = toolsRef.current;
    if (row) setTip({ text, left: chip.getBoundingClientRect().left - row.getBoundingClientRect().left });
  };
  const hideTip = () => setTip(null);
  const tipFor = (text: string) => ({
    "aria-label": text,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => showTip(text, e.currentTarget),
    onMouseLeave: hideTip,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(":focus-visible")) showTip(text, e.currentTarget);
    },
    onBlur: hideTip,
    onPointerDown: hideTip,
  });
  // 툴팁이 입력창 오른쪽 밖으로 나가지 않게 안쪽으로 당긴다.
  useLayoutEffect(() => {
    const row = toolsRef.current;
    const el = tipRef.current;
    if (!tip || !row || !el) return;
    el.style.left = `${Math.max(0, Math.min(tip.left, row.clientWidth - el.offsetWidth))}px`;
  }, [tip]);

  const models = meta?.models ?? [];
  const shown = harness === "codex" ? codexModelChip(model, activeModel, codexMeta) : modelChip(model ?? defaults.model, activeModel, models);
  // Codex 는 고르지 않은 effort 를 config.toml 이 정하므로 그 값을 보이고, 모르면 Auto
  const effortLabel = effortName(harness === "codex" ? (effort ?? codexMeta?.defaultEffort ?? null) : (effort ?? defaults.effort ?? builtinEffort(supportedLevels(model ?? defaults.model))));
  const permissionLabel = S.permissionModes[permissionMode];
  const files = sessionChanges?.files ?? [];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const hasContent = text.trim().length > 0 || attachments.length > 0 || feedback.length > 0;
  const stopMode = busy && !hasContent && agent !== null;
  const sendState = stopMode ? "stop" : hasContent ? "ready" : "empty";

  return (
    <div className="composer">
      {approval}
      {agent && (
        <div className="composer-chips">
          {files.length > 0 && (
            <button type="button" className="chip changes-chip" title={changesChipTitle(branch, panelScope, !!agent.worktree, !!sessionChanges?.shellNote)} onClick={() => openSessionChanges(agent.id, panelScope, !!agent.worktree, openChanges)}>
              <DiffMultiple size={14} />
              <span className="chip-main">{S.files(files.length)}</span>
              <span className="plus">+{additions}</span>
              <span className="minus">-{deletions}</span>
            </button>
          )}
          <PullRequestsChip agentId={agent.id} />
          <TasksChip agentId={agent.id} />
          <SubagentsChip agentId={agent.id} paneId={paneId} />
        </div>
      )}
      <div
        className="composer-box"
        ref={boxRef}
        data-busy={busy || pending || undefined}
        aria-busy={pending || undefined}
        data-dropping={dropping || undefined}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={onDrop}
      >
        {(busy || pending) && <span className="progress-line" aria-hidden="true" />}
        {dropping && <div className="composer-drop-hint">{S.fileDropHint}</div>}
        {(attachments.length > 0 || feedback.length > 0) && (
          <div className="attachments">
            {agent && <ComposerFeedback agentId={agent.id} />}
            {attachments.map((a) =>
              a.handoff ? (
                <HandoffComposerChip key={a.id} paneId={paneId} attachment={a} />
              ) : a.file ? (
                <span key={flashKey(a.id, flashing)} className="attachment attachment-file" data-status={a.file.status} data-flash={flashing?.id === a.id || undefined} title={a.file.path ?? a.file.name} aria-label={S.fileChipAria(a.file.name)}>
                  <Codicon name="file" size={12} />
                  <span className="attachment-file-name">{a.file.name}</span>
                  <span className="attachment-file-meta">{fileMeta(a.file)}</span>
                  <button type="button" className="attachment-remove" aria-label={S.removeAttachmentNamed(a.file.name)} onClick={() => removeFileChip(paneId, a)}>
                    <Close size={12} />
                  </button>
                </span>
              ) : a.image ? (
                <span key={flashKey(a.id, flashing)} className="attachment attachment-image" data-flash={flashing?.id === a.id || undefined} title={a.image.name} aria-label={S.imageThumbAria(a.image.name)}>
                  <img className="attachment-thumb" src={a.image.thumb} alt="" />
                  <button type="button" className="attachment-remove" aria-label={S.removeAttachmentNamed(a.image.name)} onClick={() => removeAttachment(paneId, a.id)}>
                    <Close size={12} />
                  </button>
                </span>
              ) : (
                <span key={flashKey(a.id, flashing)} className="attachment mono" data-flash={flashing?.id === a.id || undefined} title={a.session || a.note || a.browser ? undefined : chipTitle(a)}>
                  {attachmentLabel(a)}
                  {nameTail.has(a.id) && <span className="attachment-tail">{nameTail.get(a.id)}</span>}
                  <button type="button" className="attachment-remove" aria-label={S.removeAttachmentNamed(`${attachmentLabel(a)}${nameTail.has(a.id) ? ` ${nameTail.get(a.id)}` : ""}`)} onClick={() => removeAttachment(paneId, a.id)}>
                    <Close size={12} />
                  </button>
                </span>
              ),
            )}
          </div>
        )}
        <textarea
          id={`composer-${paneId}`}
          ref={textareaRef}
          className="textarea"
          aria-label={S.message}
          value={text}
          placeholder={agent ? (harness === "codex" ? S.composerPlaceholderCodex : S.composerPlaceholder) : harness === "codex" ? S.composerPlaceholderNewCodex : S.composerPlaceholderNew}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissedAt(null);
            setHistoryIndex(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-tools" ref={toolsRef}>
          <button ref={plusRef} type="button" className="chip chip-icon" data-chip {...tipFor(S.attach)} onClick={() => setAttachOpen((v) => !v)}>
            <AddCompact />
          </button>
          <PermissionRow mode={permissionMode} onChange={onPermissionMode} harness={harness} tip={tipFor(harness === "codex" ? `${S.permissionChipTip(permissionLabel)} (${CODEX_MODE_NOTES[permissionMode].split(". ")[0]})` : permissionMode === "bypassPermissions" ? S.permissionBypassNote : S.permissionChipTip(permissionLabel))} />
          <button type="button" className="chip" data-chip="model" data-model-chip {...tipFor(S.modelChipTip(shown.name, shown.id))} onClick={() => setState({ overlay: { kind: "models" } })}>
            <ModelIcon />
            <span className="chip-label model-label">{shown.name}</span>
          </button>
          <button type="button" className="chip" data-chip data-effort-chip {...tipFor(S.effortChipTip(effortLabel))} onClick={() => setState({ overlay: { kind: "effort" } })}>
            <span className="chip-label">{effortLabel}</span>
          </button>
          {agent && <ContextGauge agent={agent} busy={busy} />}
          <span className="spacer" />
          <button
            type="button"
            className="composer-send"
            data-state={sendState}
            aria-label={stopMode ? S.stop : S.send}
            title={stopMode ? S.stopTitle : busy ? S.sendBusyTitle(defaults.requestQueuing) : agent ? S.sendTitle : S.sendNewTitle}
            disabled={sendState === "empty" || pending}
            onClick={() => {
              if (stopMode && agent) interruptAgent(agent.id);
              else deliver(false);
            }}
          >
            {stopMode ? <Stop size={16} /> : <ArrowUpCompact size={16} />}
          </button>
          {tip && (
            <div className="chip-tip" role="tooltip" ref={tipRef}>
              {tip.text}
            </div>
          )}
        </div>
      </div>
      {footerRight && <div className="composer-meta">{footerRight}</div>}
      <input
        ref={fileInputRef}
        type="file"
        className="composer-file-input"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void addFiles(paneId, Array.from(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      {attachOpen && <AttachMenu paneId={paneId} workspaceId={workspaceId} agent={agent} anchor={plusRef.current} onClose={() => setAttachOpen(false)} onPickImage={() => fileInputRef.current?.click()} />}
      {menuOpen && trigger && <TriggerMenu trigger={trigger} items={items} index={triggerIndex} anchor={boxRef.current} onIndex={setTriggerIndex} onChoose={chooseTrigger} onClose={() => setDismissedAt(trigger.start)} />}
    </div>
  );
});

export function effortName(effort: EffortLevel | null) {
  return effort ? S.effortNames[effort] : S.effortAuto;
}

// 모델 칩에 보이는 이름(항상 버전까지)과 실제 모델 id(버그 3, 4). 마지막 턴에서 실제로 쓰인 모델이 있으면 그 이름이고, 새로 골라서 아직 쓰이지 않은 모델이면 고른 모델의 이름이다.
function modelChip(chosen: string | null, activeModel: string | null, models: { value: string; resolvedModel: string | null; displayName: string }[]) {
  const chosenInfo = chosen && chosen !== "default" ? models.find((m) => m.value === chosen || m.resolvedModel === chosen) : undefined;
  const chosenName = chosen && chosen !== "default" ? (modelName(chosen, models) ?? chosen) : null;
  const chosenId = chosenInfo?.resolvedModel ?? (chosen && chosen !== "default" ? chosen : null);
  const activeName = activeModel ? (modelName(activeModel, models) ?? activeModel) : null;
  const pending = chosenName !== null && activeModel !== null && activeModel !== chosenId && activeModel !== chosen && activeName !== chosenName;
  if (activeName && !pending) return { name: activeName, id: activeModel };
  if (chosenName) return { name: chosenName, id: chosenId };
  // 고르지 않았고 아직 쓰인 모델도 없으면 CLI 가 정할 기본 모델의 이름
  const fallback = models.find((m) => m.value === "default");
  const resolved = fallback?.resolvedModel ?? null;
  return { name: (resolved ? modelName(resolved, models) : null) ?? fallback?.displayName ?? S.default, id: resolved };
}

// 강조 중인 칩은 키에 nonce 를 붙여 다시 눌렀을 때 애니메이션이 처음부터 다시 돈다.
function flashKey(id: string, flashing: { id: string; nonce: number } | null) {
  return flashing?.id === id ? `${id}:${flashing.nonce}` : id;
}

// 파일 칩 오른쪽의 흐린 글: 올리는 중이면 진행률, 실패면 Failed, 아니면 크기
function fileMeta(file: FileAttachment) {
  if (file.status === "uploading") return `${Math.round(file.progress * 100)}%`;
  if (file.status === "error") return S.fileFailed;
  return formatBytes(file.bytes);
}

function attachmentLabel(a: Attachment) {
  if (a.browser) return browserAttachmentLabel(a.browser);
  if (a.session) return S.attachSessionLabel(a.session.title);
  if (a.note) return S.attachNoteLabel(a.note.title);
  const name = a.path.slice(a.path.lastIndexOf("/") + 1);
  if (a.startLine == null) return name;
  return a.startLine === a.endLine ? `${name}:${a.startLine}` : `${name}:${a.startLine}-${a.endLine}`;
}

// 파일 경로, 줄 범위, 선택한 텍스트를 함께 넣는다. 모델이 열 위치를 바로 잡을 수 있게 줄 번호를 명시한다.
function formatAttachment(a: Attachment) {
  if (a.handoff) return `<handoff from="${a.handoff.title}">\n${a.text ?? ""}\n</handoff>`;
  if (a.browser) return formatBrowserAttachment(a.browser);
  if (a.session) return `[${S.attachSessionLabel(a.session.title)}]\n${a.text ?? ""}`;
  if (a.note) return `[${S.attachNoteLabel(a.note.title)}]\n${a.text ?? ""}`;
  if (a.startLine == null || a.text == null) return `@${a.path}`;
  const lang = a.path.slice(a.path.lastIndexOf(".") + 1);
  const range = a.startLine === a.endLine ? `L${a.startLine}` : `L${a.startLine}-L${a.endLine}`;
  return `@${a.path}:${range}\n\`\`\`${lang}\n${a.text}\n\`\`\``;
}
