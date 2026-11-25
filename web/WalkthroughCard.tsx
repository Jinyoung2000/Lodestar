import { highlightCode } from "@lezer/highlight";
import { Suspense, use, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { parseWalkthrough, walkthroughSlide, type WalkthroughRow, type WalkthroughSlide, type WalkthroughStep } from "../shared/walkthrough";
import { syntaxHighlighters } from "./editorSyntax";
import { chatWorkspaceFor, openFileRef } from "./fileRefs";
import { ChevronLeft, ChevronRight } from "./icons";
import { languageIdFor } from "./languageId";
import { languageById, useLanguagesVersion } from "./languages";
import { rpc } from "./rpc";
import { S } from "./strings";
import { Button } from "./ui/button";
import "./walkthrough.css";

export type WalkthroughCardProps = { source: string; workspaceId: string | null; agentId: string | null };

type FileReads = Map<string, Promise<string | null>>;

export function WalkthroughCard({ source, workspaceId, agentId }: WalkthroughCardProps) {
  const steps = useMemo(() => parseWalkthrough(source), [source]);
  const [index, setIndex] = useState(0);
  const [following, setFollowing] = useState(false);
  const [reads] = useState<FileReads>(() => new Map());
  const count = steps.length;
  const current = Math.min(index, count - 1);
  const step = steps[current];
  const read = (path: string) => readOnce(reads, path, workspaceId, agentId);

  const reveal = (target: WalkthroughStep) => void read(target.path).then((text) => openStep(walkthroughSlide(text, target), workspaceId, agentId));
  const go = (next: number) => {
    const target = Math.max(0, Math.min(count - 1, next));
    if (target === current) return;
    setIndex(target);
    if (following) reveal(steps[target]);
  };
  const openInEditor = () => {
    setFollowing(true);
    reveal(step);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    go(current + (event.key === "ArrowRight" ? 1 : -1));
  };

  return (
    <div className="walkthrough" tabIndex={0} role="group" aria-label={S.walkthroughAria(current + 1, count)} onKeyDown={onKeyDown}>
      <div className="walkthrough-head">
        <span>{S.walkthrough}</span>
        <span>{S.walkthroughCount(current + 1, count)}</span>
      </div>
      {count > 1 && (
        <div className="walkthrough-rail">
          {steps.map((s, i) => (
            <button key={i} type="button" className="walkthrough-tick" data-state={i === current ? "current" : i < current ? "done" : undefined} aria-label={S.walkthroughGoTo(i + 1, s.path)} title={`${i + 1}. ${s.path}`} onClick={() => go(i)} />
          ))}
        </div>
      )}
      {step.note && <div className="walkthrough-note">{noteParts(step.note)}</div>}
      <Suspense key={current} fallback={<StepPlaceholder step={step} />}>
        <StepCode file={read(step.path)} step={step} onOpen={openInEditor} />
      </Suspense>
      <div className="walkthrough-foot">
        <Button variant="secondary" disabled={current === 0} onClick={() => go(current - 1)}>
          <ChevronLeft size={14} />
          {S.walkthroughBack}
        </Button>
        <Button variant="primary" disabled={current === count - 1} onClick={() => go(current + 1)}>
          {S.walkthroughNext}
          <ChevronRight size={14} />
        </Button>
        <span className="walkthrough-spacer" />
        <Button variant={following ? "ghost-on" : "ghost"} aria-pressed={following} title={following ? S.walkthroughFollowingTip : S.walkthroughOpenTip} onClick={following ? () => setFollowing(false) : openInEditor}>
          {following ? S.walkthroughFollowing : S.walkthroughOpen}
        </Button>
      </div>
    </div>
  );
}

function StepCode({ file, step, onOpen }: { file: Promise<string | null>; step: WalkthroughStep; onOpen: () => void }) {
  const slide = walkthroughSlide(use(file), step);
  return (
    <>
      <button type="button" className="walkthrough-path" title={S.walkthroughOpenTip} onClick={onOpen}>
        {slide.line === null ? step.path : `${step.path}:${slide.line}`}
      </button>
      {slide.missing && <div className="walkthrough-missing">{slide.missing === "file" ? S.walkthroughNoFile : S.walkthroughNoLine}</div>}
      {slide.rows.length > 0 && <CodeRows slide={slide} />}
    </>
  );
}

function StepPlaceholder({ step }: { step: WalkthroughStep }) {
  return (
    <>
      <span className="walkthrough-path">{`${step.path}:${step.start}`}</span>
      <div className="walkthrough-code walkthrough-loading">{S.walkthroughLoading}</div>
    </>
  );
}

const SIGN: Record<WalkthroughRow["kind"], string> = { context: " ", focus: " ", removed: "-", added: "+" };

function CodeRows({ slide }: { slide: WalkthroughSlide }) {
  useLanguagesVersion();
  const language = languageById(languageIdFor(slide.step.path));
  const digits = String(Math.max(1, ...slide.rows.map((row) => row.line ?? 1))).length;
  return (
    <div className="walkthrough-code">
      <div className="walkthrough-lines" style={{ "--walkthrough-digits": digits } as CSSProperties}>
        {slide.rows.map((row, i) => (
          <div key={i} className="walkthrough-row" data-kind={row.kind}>
            <span className="walkthrough-number">{row.line ?? ""}</span>
            <span className="walkthrough-sign">{SIGN[row.kind]}</span>
            <span className="walkthrough-text">{language ? highlightLine(row.text, language) : row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function highlightLine(text: string, language: NonNullable<ReturnType<typeof languageById>>): ReactNode[] {
  const parts: ReactNode[] = [];
  highlightCode(
    text,
    language.parser.parse(text),
    syntaxHighlighters,
    (piece, cls) => parts.push(cls ? <span key={parts.length} className={cls}>{piece}</span> : piece),
    () => undefined,
  );
  return parts;
}

function noteParts(note: string): ReactNode[] {
  return note.split(/(`[^`]+`)/).map((part, i) => (part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

function readOnce(reads: FileReads, path: string, workspaceId: string | null, agentId: string | null): Promise<string | null> {
  const known = reads.get(path);
  if (known) return known;
  const loading = readStepFile(path, workspaceId, agentId);
  reads.set(path, loading);
  return loading;
}

async function readStepFile(path: string, workspaceId: string | null, agentId: string | null): Promise<string | null> {
  const request = agentId ? rpc.call("files.readOfAgent", { agentId, path }) : workspaceId ? rpc.call("files.read", { workspaceId, path }) : null;
  if (!request) return null;
  return request.then((result) => result.text).catch(() => null);
}

function openStep(slide: WalkthroughSlide, workspaceId: string | null, agentId: string | null) {
  const line = slide.line ?? slide.step.start;
  const marked = slide.rows.filter((row) => (row.kind === "focus" || row.kind === "removed") && row.line !== null).map((row) => row.line!);
  const endLine = marked.length ? Math.max(...marked) : line;
  const ref = { raw: slide.step.path, line };
  const target = workspaceId ?? (agentId ? chatWorkspaceFor(agentId, ref) : null);
  if (target) void openFileRef(target, ref, endLine > line ? { endLine } : {}, { preview: true, preserveFocus: true });
  else if (agentId) void rpc.call("agents.openChatFile", { agentId, path: slide.step.path }).catch(() => undefined);
}
