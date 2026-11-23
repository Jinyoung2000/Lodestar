import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { defaultChangeScope, type Agent, type EffortLevel, type FileRef, type ImageRef, type PermissionMode } from "../shared/protocol";
import { AttachMenu } from "./AttachMenu";
import { changesChipTitle, openSessionChanges } from "./changesChip";
import { useChangesView } from "./changesState";
import { ComposerFeedback } from "./DiffFeedbackChips";
import { pendingOf, sendDiffFeedback, useDiffFeedback } from "./diffFeedbackState";
import { applyMention, applyTrigger, continueMarkdown, draftKey, findTrigger, getDraft, historyOf, removeMention, setDraft, stepHistory, subscribeDraft } from "./composerState";
import { deleteFileRef, inlineFileRefs } from "./composerFileRefs";
import { selectionOf } from "./attachments";
import { nameTails, chipTitle } from "./attachDedupe";
import { useFlashingAttachment } from "./attachFlash";
import { clipboardImageFiles, dragHasFiles, uploadImages } from "./imageAttach";
import { addDropped, addFiles, fileRefsOf, removeFileChip } from "./fileAttach";
import { formatBytes } from "../shared/files";
import { SESSION_REF_PREFIX } from "../shared/sessionRef";
import { browserAttachmentLabel, formatBrowserAttachment } from "./browserAttach";
import { AddCompact, ArrowUpCompact, Codicon, DiffMultiple, ProviderIcon, Stop } from "./icons";
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
import { FolderChip } from "./FolderChip";
import { interruptAgent } from "./sessionActions";
import { lastPending } from "./pendingMessages";
import { editPending } from "./Queue";
import { currentDefaults, sideChatModel, useDefaults } from "./defaults";
import { builtinEffort, supportedLevels } from "./effortLevels";
import { S } from "./strings";
import { hint } from "./hint";
import { CODEX_MODE_NOTES } from "../shared/codexPermission";
import { ANTIGRAVITY_MODE_NOTES } from "../shared/antigravityPermission";
import { codexModelChip, compactModelName, usePaneHarness, useToolMeta } from "./harness";
import { continueMarkdown as continueMarkdownEdit, indentMarkdown, type MarkdownEdit } from "./composerMarkdown";
import { useCommandKey } from "./commandKeys";

export { PERMISSION_MODES } from "./PermissionMenu";


type ComposerProps = {
  paneId: string;
  agent: Agent | null;
  workspaceId: string | null;
  busy: boolean;
  permissionMode: PermissionMode;
  onPermissionMode: (mode: PermissionMode) => void;
  model: string | null;
  activeModel: string | null;
  effort: EffortLevel | null;
  footerRight?: ReactNode;
  approval?: ReactNode;
  onSubmit: (prompt: string, options: { steer: boolean; shown?: string; handoff?: { sourceId: string; id: string }; images?: ImageRef[]; files?: FileRef[] }) => Promise<unknown>;
  onSubmitBackground?: (prompt: string, images?: ImageRef[], files?: FileRef[]) => Promise<unknown>;
  beforeSubmit?: () => boolean;
};

export const Composer = memo(function Composer({ paneId, agent, workspaceId, busy, permissionMode, onPermissionMode, model, activeModel, effort, footerRight, approval, onSubmit, onSubmitBackground, beforeSubmit }: ComposerProps) {
  const storageKey = draftKey(agent?.id ?? null, paneId);
  const text = useSyncExternalStore(subscribeDraft, () => getDraft(storageKey));
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [triggerIndex, setTriggerIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useStore((s) => s.attachments[storageKey] ?? NO_ATTACHMENTS);
  const { chips, inlineAttachments } = useMemo(() => ({
    chips: attachments.filter((attachment) => !attachment.inlineRef),
    inlineAttachments: new Map(attachments.flatMap((attachment) => attachment.inlineRef ? [[attachment.inlineRef, attachment] as const] : [])),
  }), [attachments]);
  const refs = useMemo(() => inlineFileRefs(text, inlineAttachments.keys()), [text, inlineAttachments]);
  const workspaces = useStore((s) => s.workspaces);
  const nameTail = useMemo(() => nameTails(chips, (id) => workspaces.find((w) => w.id === id)?.dir), [chips, workspaces]);
  const flashing = useFlashingAttachment();
  const feedback = pendingOf(useDiffFeedback(agent?.id));
  const focusRequest = useStore((s) => (s.focusComposer?.paneId === paneId ? s.focusComposer.nonce : null));
  const prefill = useStore((s) => s.composerPrefill[paneId]);
  const action = useStore((s) => (s.composerAction?.paneId === paneId ? s.composerAction : null));
  const meta = useStore((s) => s.meta);
  const harness = usePaneHarness(paneId, agent);
  const pickerOpen = useStore((s) => s.activePaneId === paneId && (s.overlay?.kind === "models" || s.overlay?.kind === "effort"));
  const codexMeta = useToolMeta(harness);
  const sessionChanges = useStore((s) => (agent ? s.sessionChanges[agent.id] : undefined));
  const branch = useStore((s) => (agent ? (s.gitInfo[agent.id]?.branch ?? null) : null));
  const panelScope = useChangesView((s) => (agent ? (s.scope[agent.id] ?? defaultChangeScope(agent)) : "branch"));
  const defaults = useDefaults();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const refsBackdrop = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  const setText = (next: string) => setDraft(storageKey, next);

  useEffect(() => {
    if (focusRequest != null) textareaRef.current?.focus();
  }, [focusRequest]);
  const appliedPrefill = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || appliedPrefill.current === prefill.nonce) return;
    appliedPrefill.current = prefill.nonce;
    const current = getDraft(storageKey);
    setDraft(storageKey, prefill.append && current.trim() ? `${current}\n${prefill.text}` : prefill.text);
    setState((s) => {
      const { [paneId]: _used, ...rest } = s.composerPrefill;
      return { composerPrefill: rest };
    });
  }, [prefill, paneId, storageKey]);
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
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (refsBackdrop.current) refsBackdrop.current.scrollTop = el.scrollTop;
  }, [text, refs.length]);

  const found = useMemo(() => findTrigger(text, caret), [text, caret]);
  const trigger = found && found.start !== dismissedAt && !refs.some(({ from, to }) => from < caret && caret <= to) ? found : null;
  const items = useTriggerItems(trigger, workspaceId, agent !== null, harness);
  const menuOpen = trigger !== null && items.length > 0;
  useEffect(() => setTriggerIndex(0), [trigger?.kind, trigger?.query]);

  const reset = (sentText: string, sentIds: ReadonlySet<string>) => {
    const current = getDraft(storageKey);
    const next = current === sentText ? "" : current.startsWith(sentText) ? current.slice(sentText.length).replace(/^\s+/, "") : current;
    setDraft(storageKey, next);
    setHistoryIndex(null);
    setCaret(0);
    const removable = new Set(sentIds);
    for (const { value } of inlineFileRefs(next, inlineAttachments.keys())) {
      const attachment = inlineAttachments.get(value);
      if (attachment) removable.delete(attachment.id);
    }
    clearAttachmentsByKey(storageKey, removable);
  };
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
    const quotes = chips.filter((a) => a.quote).map(formatAttachment);
    const context = chips.filter((a) => !a.handoff && !a.image && !a.file && !a.quote).map(formatAttachment);
    for (const value of new Set(refs.map((ref) => ref.value))) {
      const attachment = inlineAttachments.get(value);
      if (attachment && attachment.text !== null) context.push(formatAttachment(attachment));
    }
    if (!prompt && !quotes.length && !context.length && !handoffChip && !imageChips.length && !fileChips.length) return feedback.length ? "" : null;
    if (handoffChip) return [formatAttachment(handoffChip), prompt || S.handoffContinue, ...quotes, ...context].join("\n\n");
    return [...quotes, prompt, ...context].filter(Boolean).join("\n\n");
  };
  const tryBtw = () => {
    const m = /^\/btw\b\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return false;
    if (!agent) {
      hint(S.btwNeedsSession);
      return true;
    }
    if (harness !== "claude") {
      hint(S.harnessUnavailable(harness, "/btw"));
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
      if (getState().layoutMode !== "editor") setState({ sidebarOpen: true });
      startRename(agent.id);
    }
    return true;
  };
  const deliver = (flip: boolean) => {
    if (tryBtw() || tryRename()) return;
    const prompt = compose();
    if (prompt === null) return;
    if (handoffChip?.handoff?.status === "generating") {
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
      const next = removeMention(text, trigger);
      setText(next.text);
      moveCaret(next.caret);
      void attachNotionPage({ url: item.url, title: item.title, paneId });
      return;
    }
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
  const applyEdit = (el: HTMLTextAreaElement, edit: MarkdownEdit) => {
    if (edit.insert !== el.value.slice(edit.from, edit.to)) {
      el.setSelectionRange(edit.from, edit.to);
      if (!(edit.insert ? document.execCommand("insertText", false, edit.insert) : document.execCommand("delete"))) {
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
    if (plain && el.selectionStart === el.selectionEnd && (e.key === "Backspace" || e.key === "Delete")) {
      const edit = deleteFileRef(el.value, refs, el.selectionStart, e.key === "Backspace");
      if (edit) {
        e.preventDefault();
        applyEdit(el, edit);
        return;
      }
    }
    const pending = plain && e.key === "ArrowUp" && text === "" && historyIndex === null && agent ? lastPending(agent) : null;
    if (pending && agent) {
      e.preventDefault();
      void editPending(agent.id, paneId, pending).catch((error: Error) => flash(error.message));
      return;
    }
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
    if (e.key === "Enter" && e.metaKey && !e.shiftKey && !e.ctrlKey && pendingToolApproval()) return;
    if (e.key === "Tab" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onPermissionMode(nextPermissionMode(permissionMode, harness));
      return;
    }
    if (!e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "Tab" || (e.key === "Enter" && e.shiftKey))) {
      const edit = e.key === "Tab" ? indentMarkdown(el.value, el.selectionStart, el.selectionEnd, e.shiftKey) : continueMarkdownEdit(el.value, el.selectionStart, el.selectionEnd);
      if (edit) {
        e.preventDefault();
        applyEdit(el, edit);
        return;
      }
    }
    if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && el.selectionStart === el.selectionEnd && /^\s*>/.test(el.value.slice(el.value.lastIndexOf("\n", el.selectionStart - 1) + 1))) {
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

  const toolsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; left: number } | null>(null);
  const showTip = (text: string, chip: HTMLElement) => {
    const row = toolsRef.current;
    if (row) setTip({ text, left: chip.getBoundingClientRect().left - row.getBoundingClientRect().left });
  };
  const hideTip = () => setTip(null);
  const attachKey = useCommandKey("attach");
  const modelsKey = useCommandKey("models");
  const stopKey = useCommandKey("interrupt");
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
  useLayoutEffect(() => {
    const row = toolsRef.current;
    const el = tipRef.current;
    if (!tip || !row || !el) return;
    el.style.left = `${Math.max(0, Math.min(tip.left, row.clientWidth - el.offsetWidth))}px`;
  }, [tip]);

  const models = meta?.models ?? [];
  const shown = harness !== "claude" ? codexModelChip(model, activeModel, codexMeta, S.harnessNames[harness]) : modelChip(model ?? defaults.model, activeModel, models);
  const effortLabel = effortName(harness !== "claude" ? (effort ?? codexMeta?.defaultEffort ?? null) : (effort ?? defaults.effort ?? builtinEffort(supportedLevels(model ?? defaults.model))));
  const permissionLabel = S.permissionModes[permissionMode];
  const files = sessionChanges?.files ?? [];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const hasContent = text.trim().length > 0 || chips.length > 0 || feedback.length > 0;
  const stopMode = busy && !hasContent && agent !== null;
  const sendState = stopMode ? "stop" : hasContent ? "ready" : "empty";

  return (
    <div className="composer">
      {approval}
      {agent && (
        <div className="composer-chips">
          <FolderChip agent={agent} branch={branch} />
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
        {(chips.length > 0 || feedback.length > 0) && (
          <div className="attachments">
            {agent && <ComposerFeedback agentId={agent.id} />}
            {chips.map((a) =>
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
              ) : a.quote ? (
                <span key={flashKey(a.id, flashing)} className="attachment attachment-quote" title={`${quoteLines(a.text ?? "")}\n\n${a.quote.comment}`} aria-label={S.quoteCommentChipAria(a.quote.comment)}>
                  <Codicon name="comment" size={12} />
                  <span className="attachment-file-name">{a.quote.comment}</span>
                  <button type="button" className="attachment-remove" aria-label={S.removeAttachmentNamed(a.quote.comment)} onClick={() => removeAttachment(paneId, a.id)}>
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
                <span key={flashKey(a.id, flashing)} className={a.session ? "attachment mono attachment-session" : "attachment mono"} data-flash={flashing?.id === a.id || undefined} title={a.session ? attachmentLabel(a) : a.note || a.browser ? undefined : chipTitle(a)}>
                  {a.session ? <span className="attachment-session-label">{attachmentLabel(a)}</span> : attachmentLabel(a)}
                  {nameTail.has(a.id) && <span className="attachment-tail">{nameTail.get(a.id)}</span>}
                  <button type="button" className="attachment-remove" aria-label={S.removeAttachmentNamed(`${attachmentLabel(a)}${nameTail.has(a.id) ? ` ${nameTail.get(a.id)}` : ""}`)} onClick={() => removeAttachment(paneId, a.id)}>
                    <Close size={12} />
                  </button>
                </span>
              ),
            )}
          </div>
        )}
        <div className="composer-message" data-inline-refs={refs.length > 0 || undefined}>
          {refs.length > 0 && (
            <div className="textarea composer-ref-backdrop" ref={refsBackdrop} aria-hidden="true">
              {refs.map(({ from, value }, index) => (
                <Fragment key={from}>
                  {text.slice(refs[index - 1]?.to ?? 0, from)}
                  <span className="composer-file-ref">{value}</span>
                </Fragment>
              ))}
              {text.slice(refs[refs.length - 1].to)}{"\u200b"}
            </div>
          )}
          <textarea
            id={`composer-${paneId}`}
            ref={textareaRef}
            className="textarea"
            aria-label={S.message}
            spellCheck={refs.length > 0 ? false : undefined}
            value={text}
            placeholder={agent ? (harness === "codex" ? S.composerPlaceholderCodex : harness === "antigravity" ? S.composerPlaceholderAntigravity : S.composerPlaceholder) : harness === "codex" ? S.composerPlaceholderNewCodex : harness === "antigravity" ? S.composerPlaceholderNewAntigravity : S.composerPlaceholderNew}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setDismissedAt(null);
              setHistoryIndex(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onScroll={(e) => {
              if (refsBackdrop.current) refsBackdrop.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        <div className="composer-tools" ref={toolsRef}>
          <button ref={plusRef} type="button" className="chip chip-icon" data-chip {...tipFor(S.attach(attachKey))} onClick={() => setAttachOpen((v) => !v)}>
            <AddCompact />
          </button>
          <PermissionRow mode={permissionMode} onChange={onPermissionMode} harness={harness} tip={tipFor(harness !== "claude" ? `${S.permissionChipTip(permissionLabel)} (${(harness === "codex" ? CODEX_MODE_NOTES : ANTIGRAVITY_MODE_NOTES)[permissionMode].split(". ")[0]})` : permissionMode === "bypassPermissions" ? S.permissionBypassNote : S.permissionChipTip(permissionLabel))} />
          <button type="button" className="chip" data-chip="model" data-model-chip aria-haspopup="dialog" aria-expanded={pickerOpen} {...tipFor(S.modelEffortChipTip(shown.name, shown.id, effortLabel, modelsKey))} onClick={() => setState({ overlay: { kind: "models" } })}>
            <ProviderIcon harness={harness} size={14} />
            <span className="chip-label model-label chip-main">{harness === "claude" ? shown.name : compactModelName(shown.name)}</span>
            <span className="chip-label">{effortLabel}</span>
          </button>
          {agent && <ContextGauge agent={agent} busy={busy} />}
          <span className="spacer" />
          <button
            type="button"
            className="composer-send"
            data-state={sendState}
            aria-label={stopMode ? S.stop : S.send}
            title={stopMode ? S.stopTitle(stopKey) : busy ? S.sendBusyTitle(defaults.requestQueuing) : agent ? S.sendTitle : S.sendNewTitle}
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

function modelChip(chosen: string | null, activeModel: string | null, models: { value: string; resolvedModel: string | null; displayName: string }[]) {
  const chosenInfo = chosen && chosen !== "default" ? models.find((m) => m.value === chosen || m.resolvedModel === chosen) : undefined;
  const chosenName = chosen && chosen !== "default" ? (modelName(chosen, models) ?? chosen) : null;
  const chosenId = chosenInfo?.resolvedModel ?? (chosen && chosen !== "default" ? chosen : null);
  const activeName = activeModel ? (modelName(activeModel, models) ?? activeModel) : null;
  const pending = chosenName !== null && activeModel !== null && activeModel !== chosenId && activeModel !== chosen && activeName !== chosenName;
  if (activeName && !pending) return { name: activeName, id: activeModel };
  if (chosenName) return { name: chosenName, id: chosenId };
  const fallback = models.find((m) => m.value === "default");
  const resolved = fallback?.resolvedModel ?? null;
  return { name: (resolved ? modelName(resolved, models) : null) ?? fallback?.displayName ?? S.default, id: resolved };
}

function flashKey(id: string, flashing: { id: string; nonce: number } | null) {
  return flashing?.id === id ? `${id}:${flashing.nonce}` : id;
}

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

function formatAttachment(a: Attachment) {
  if (a.quote) return `${quoteLines(a.text ?? "")}\n\n${a.quote.comment}`;
  if (a.handoff) return `<handoff from="${a.handoff.title}">\n${a.text ?? ""}\n</handoff>`;
  if (a.browser) return formatBrowserAttachment(a.browser);
  if (a.session) {
    const label = S.attachSessionLabel(a.session.title).replace(/[\\[\]]/g, "\\$&");
    return `[${label}](${SESSION_REF_PREFIX}${a.path})\n${a.text ?? ""}`;
  }
  if (a.note) return `[${S.attachNoteLabel(a.note.title)}]\n${a.text ?? ""}`;
  if (a.startLine == null || a.text == null) return `@${a.path}`;
  const lang = a.path.slice(a.path.lastIndexOf(".") + 1);
  const range = a.startLine === a.endLine ? `L${a.startLine}` : `L${a.startLine}-L${a.endLine}`;
  return `${a.inlineRef ?? `@${a.path}:${range}`}\n\`\`\`${lang}\n${a.text}\n\`\`\``;
}

function quoteLines(text: string) {
  return text.trim().split("\n").map((line) => `> ${line}`).join("\n");
}
