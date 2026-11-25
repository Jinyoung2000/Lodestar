import type { Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TermAskRun } from "../shared/protocol";
import { extractCommand, FIX_SUGGESTION, looksLikeError, recentOutput, runConfirmReasons, selectionContext, type TermAskContext } from "../shared/termAsk";
import { ArrowUpCompact, Close, ModelIcon, Stop, Warning } from "./icons";
import { ModelMenu } from "./Pickers";
import { rpc } from "./rpc";
import { flash, useStore } from "./store";
import { S } from "./strings";
import { Markdown } from "./Timeline";
import { modelName } from "./timelineModel";
import { effortName } from "./Composer";
import { useDefaults } from "./defaults";
import { shownEffort } from "./effortLevels";
import { Button } from "./ui/button";
import { hint } from "./hint";

type Info = { cwd: string; shell: string; os: string };

export function TerminalAsk({ term, ptyId, selection, onClose }: { term: Terminal; ptyId: string; selection: string | null; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const defaults = useDefaults();
  const meta = useStore((s) => s.meta);
  const [info, setInfo] = useState<Info | null>(null);
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [run, setRun] = useState<TermAskRun | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [again, setAgain] = useState(false);
  const [opening] = useState(() => {
    const lines = bufferLines(term);
    const output = recentOutput(lines);
    return { suggestion: looksLikeError(lines) ? FIX_SUGGESTION : null, lineCount: output ? output.split("\n").length : 0 };
  });
  const suggestion = opening.suggestion;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const selectNext = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const chosenModel = model ?? settings?.quickModel ?? "haiku";
  const running = run?.status === "running";
  const extracted = run?.status === "done" ? extractCommand(run.answer) : null;
  const reasons = extracted ? runConfirmReasons(extracted.command) : [];
  const sendState = running ? "stop" : question.trim() || (suggestion && !run) ? "ready" : "empty";

  useEffect(() => {
    textareaRef.current?.focus();
    void readInfo(ptyId).then(setInfo);
    const off = rpc.onEvent((event) => {
      if (event.type === "termask" && event.run.id === runIdRef.current) setRun(event.run);
    });
    const bottom = boxRef.current?.closest<HTMLElement>(".bottom");
    if (bottom) bottom.dataset.termask = "";
    return () => {
      off();
      if (bottom) delete bottom.dataset.termask;
    };
  }, []);
  useEffect(() => {
    const el = answerRef.current;
    if (el) el.scrollTop = run?.status === "running" ? el.scrollHeight : 0;
  }, [run?.answer, run?.status]);
  useEffect(() => {
    setConfirming(false);
  }, [run?.id, run?.status]);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (selectNext.current) {
      selectNext.current = false;
      el.select();
    }
  }, [question]);

  const close = () => {
    if (running && run) void rpc.call("termask.cancel", { id: run.id });
    onClose();
  };
  const ask = async () => {
    const text = question.trim() || (suggestion && !run ? suggestion : "");
    if (!text || running) return;
    const id = `termask-${Date.now()}`;
    runIdRef.current = id;
    setRun({ id, model: chosenModel, question: text, answer: "", status: "running" });
    setQuestion("");
    setAgain(false);
    const fresh = (await readInfo(ptyId)) ?? info;
    if (fresh) setInfo(fresh);
    const context: TermAskContext = {
      cwd: fresh?.cwd ?? "",
      shell: fresh?.shell ?? "sh",
      os: fresh?.os ?? "unknown",
      output: recentOutput(bufferLines(term)),
      selection: selectionContext(selection ?? term.getSelection()),
      previous: run?.status === "done" && !again ? { question: run.question, answer: run.answer } : null,
    };
    void rpc.call("termask.ask", { id, model: chosenModel, question: text, context }).catch((error: Error) => {
      setRun({ id, model: chosenModel, question: text, answer: error.message, status: "error" });
    });
  };
  const runCommand = () => {
    if (!extracted) return;
    if (reasons.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    term.input("\x15", true);
    term.paste(extracted.command);
    term.input("\r", true);
    onClose();
  };
  const insertCommand = () => {
    if (!extracted) return;
    term.paste(extracted.command);
    onClose();
  };
  const copyCommand = () => {
    if (!extracted) return;
    void navigator.clipboard.writeText(extracted.command).then(
      () => hint(S.copied, undefined, { check: true }),
      () => flash(S.copyFailed),
    );
  };
  const askAgain = () => {
    if (!run) return;
    setAgain(true);
    selectNext.current = true;
    setQuestion(run.question);
    textareaRef.current?.focus();
  };

  const models = meta?.models ?? [];
  return (
    <>
      <div
        className="termask composer-box"
        role="dialog"
        aria-label={S.terminalAsk}
        ref={boxRef}
        data-busy={running || undefined}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === "Enter" && event.metaKey && extracted) {
            event.preventDefault();
            runCommand();
          } else if (event.key === "Enter" && event.altKey && extracted) {
            event.preventDefault();
            insertCommand();
          }
        }}
      >
        {running && <span className="progress-line" aria-hidden="true" />}
        <div className="attachments termask-top">
          {info && (
            <span className="attachment mono termask-cwd" title={info.cwd}>
              {shortPath(info.cwd)}
            </span>
          )}
          <span className="attachment mono">{S.terminalAskLines(opening.lineCount)}</span>
          {selection && <span className="attachment mono">{S.terminalAskSelection}</span>}
          <Button size="icon" className="quick-close" aria-label={S.close} title={S.closeEsc} onClick={close}>
            <Close />
          </Button>
        </div>
        {run && (
          <div className="quick-answer termask-answer" ref={answerRef}>
            {run.answer && <Markdown className={running ? "row-assistant streaming" : "row-assistant"} text={run.answer} />}
            {running && !run.answer && <div className="muted small">{S.terminalAskWaiting}</div>}
            {run.status === "error" && <div className="row-error">{run.answer}</div>}
            {run.status === "done" && !extracted && <div className="muted small">{S.terminalAskNoCommand}</div>}
          </div>
        )}
        {extracted && (
          <div className="termask-actions">
            {reasons.length > 0 && (
              <div className="termask-warn" role="alert">
                <Warning size={14} />
                <span>{reasons.join(". ")}</span>
              </div>
            )}
            {extracted.blocks > 1 && <div className="muted small">{S.terminalAskFirstOnly(extracted.blocks)}</div>}
            <div className="termask-buttons">
              <Button size="sm" variant="primary" data-danger={reasons.length > 0 || undefined} data-confirming={confirming || undefined} title={confirming ? S.terminalAskRunConfirmTitle : S.terminalAskRunTitle} onClick={runCommand}>
                {confirming ? S.terminalAskRunAnyway : S.terminalAskRun}
                <span className="termask-key">⌘↵</span>
              </Button>
              <Button size="sm" variant="secondary" title={S.terminalAskInsertTitle} onClick={insertCommand}>
                {S.terminalAskInsert}
                <span className="termask-key">⌥↵</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={copyCommand}>
                {S.terminalAskCopy}
              </Button>
              <span className="spacer" />
              <Button size="sm" variant="ghost" title={S.terminalAskAgainTitle} onClick={askAgain}>
                {S.terminalAskAgain}
              </Button>
            </div>
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="textarea termask-input"
          aria-label={S.question}
          rows={1}
          placeholder={run ? S.terminalAskFollowUp : suggestion ? S.terminalAskFixHint(suggestion) : S.terminalAskPlaceholder}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              void ask();
            } else if (e.key === "Tab" && !e.shiftKey && !question && suggestion && !run) {
              e.preventDefault();
              setQuestion(suggestion);
            }
          }}
        />
        <div className="composer-tools">
          <button ref={modelChipRef} type="button" className="chip" data-chip="model" aria-label={S.terminalAskModel} title={S.terminalAskModel} onClick={() => setModelOpen((open) => !open)}>
            <ModelIcon />
            <span className="chip-label model-label">{modelName(chosenModel, models)}</span>
            <span className="chip-label">{effortName(shownEffort(chosenModel, null, defaults.effort))}</span>
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="composer-send"
            data-state={sendState}
            aria-label={running ? S.stop : S.ask}
            title={running ? S.stop : S.sendTitle}
            disabled={sendState === "empty"}
            onClick={() => {
              if (running && run) void rpc.call("termask.cancel", { id: run.id });
              else void ask();
            }}
          >
            {running ? <Stop size={16} /> : <ArrowUpCompact size={16} />}
          </button>
        </div>
      </div>
      {modelOpen && (
        <ModelMenu
          anchor={modelChipRef.current}
          current={chosenModel}
          onClose={() => {
            setModelOpen(false);
            textareaRef.current?.focus();
          }}
          onChoose={(value) => {
            setModel(value);
            void rpc.call("settings.set", { quickModel: value });
          }}
        />
      )}
    </>
  );
}

async function readInfo(ptyId: string): Promise<Info | null> {
  try {
    return await rpc.call("pty.info", { ptyId });
  } catch {
    flash(S.terminalAskInfoFailed, "warning");
    return null;
  }
}

export function bufferLines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}

function shortPath(path: string) {
  const home = path.match(/^\/Users\/[^/]+/)?.[0];
  const tilde = home ? `~${path.slice(home.length)}` : path;
  const parts = tilde.split("/");
  return parts.length > 3 ? `.../${parts.slice(-2).join("/")}` : tilde;
}
