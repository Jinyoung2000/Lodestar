import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CodeMenu, usePrCodeLsp } from "./PrCodeLsp";
import type { PrLsp } from "./usePrLsp";
import { parsePatch, placeThreads, rightText, rowSide, toSplit, type DiffLine, type DiffRow, type Side, type SplitRow } from "../shared/prDiff";
import type { PrFile, PrThread } from "../shared/prTypes";
import { useDiffView } from "./diffMode";
import { PrComposer } from "./PrComposer";
import { PrThreadView } from "./PrThread";
import { useLanguagesVersion } from "./languages";
import { highlightLines, type Seg } from "./prHighlight";
import { usePrActions, usePrView } from "./prStore";
import { P } from "./prStrings";
import { Codicon } from "./icons";
import { Button } from "./ui/button";

// 한 파일의 PR diff. GitHub 가 준 patch 의 hunk 만 그린다(inline 또는 split, 설정 diffView 를 따른다).
// 줄 번호 칸을 누르거나 끌면 그 줄 또는 범위에 코멘트 입력창이 열리고, 기존 리뷰 스레드는 끝 줄 아래에 붙는다.
const ROW_LIMIT = 3000;

type Range = { side: Side; anchor: number; head: number };

export function PrDiff({ file, threads, lsp }: { file: PrFile; threads: PrThread[]; lsp: PrLsp }) {
  const [mode] = useDiffView();
  const rows = useMemo(() => parsePatch(file.patch ?? ""), [file.patch]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, ROW_LIMIT);
  const languagesVersion = useLanguagesVersion();
  const code = useMemo(() => highlightRows(shown, file.path), [shown, file.path, languagesVersion]);
  const placement = useMemo(() => placeThreads(rows, threads), [rows, threads]);
  const [range, setRange] = useState<Range | null>(null);
  const [composer, setComposer] = useState<Range | null>(null);
  const dragging = useRef<Range | null>(null);

  // 파일을 바꾸면 열려 있던 선택과 입력창은 닫는다.
  useEffect(() => {
    setRange(null);
    setComposer(null);
    setShowAll(false);
  }, [file.path]);

  const start = (side: Side, index: number) => {
    dragging.current = { side, anchor: index, head: index };
    setRange(dragging.current);
    const finish = () => {
      window.removeEventListener("mouseup", finish);
      const done = dragging.current;
      dragging.current = null;
      if (!done) return;
      setRange(null);
      setComposer({ ...done, anchor: Math.min(done.anchor, done.head), head: Math.max(done.anchor, done.head) });
    };
    window.addEventListener("mouseup", finish);
  };
  const extend = (side: Side, index: number) => {
    const drag = dragging.current;
    if (!drag || drag.side !== side) return;
    const row = rows[index];
    if (row?.kind !== "line" || rowSide(row, side) === null) return;
    dragging.current = { ...drag, head: index };
    setRange(dragging.current);
  };

  const selection = range ?? composer;
  const lo = selection ? Math.min(selection.anchor, selection.head) : -1;
  const hi = selection ? Math.max(selection.anchor, selection.head) : -1;
  const ctx: Ctx = { rows, code, placement, start, extend, composer, closeComposer: () => setComposer(null), selection: selection ? { side: selection.side, lo, hi } : null, path: file.path };
  const { rootRef, menu, closeMenu, goToDefinition, findReferences } = usePrCodeLsp(file, rows, lsp);

  if (!file.patch) return <div className="pr-diff-empty">{file.status === "renamed" ? P.renamedFrom(file.previousPath ?? "") : P.noPatch}</div>;
  return (
    <div className="pr-diff" data-mode={mode} role="table" aria-label={file.path} ref={rootRef} data-lsp={lsp.doc ? "" : undefined}>
      {mode === "split" ? <SplitRows ctx={ctx} shown={shown} /> : <InlineRows ctx={ctx} shown={shown} />}
      {rows.length > shown.length && (
        <div className="pr-diff-more">
          <span className="pr-faint">{P.diffTooLarge}</span>
          <Button variant="secondary" onClick={() => setShowAll(true)}>
            {P.showAllLines}
          </Button>
        </div>
      )}
      {menu && <CodeMenu menu={menu} onClose={closeMenu} onDefinition={goToDefinition} onReferences={findReferences} />}
      {placement.unplaced.length > 0 && (
        <div className="pr-outside">
          <div className="pr-outside-title">{P.outsideDiff}</div>
          {placement.unplaced.map((thread) => (
            <PrThreadView key={thread.id} thread={thread} />
          ))}
        </div>
      )}
    </div>
  );
}

type Ctx = {
  rows: DiffRow[];
  code: Seg[][];
  placement: { byRow: Map<number, PrThread[]> };
  start: (side: Side, index: number) => void;
  extend: (side: Side, index: number) => void;
  composer: Range | null;
  closeComposer: () => void;
  selection: { side: Side; lo: number; hi: number } | null;
  path: string;
};

function InlineRows({ ctx, shown }: { ctx: Ctx; shown: DiffRow[] }) {
  return (
    <>
      {shown.map((row, index) => (
        <Fragment key={index}>
          {row.kind === "hunk" ? <HunkRow row={row} /> : <InlineLine row={row} index={index} ctx={ctx} />}
          <Widgets index={index} ctx={ctx} />
        </Fragment>
      ))}
    </>
  );
}

function HunkRow({ row }: { row: Extract<DiffRow, { kind: "hunk" }> }) {
  return (
    <div className="pr-hunk" role="row">
      <span className="pr-hunk-text">{row.header}</span>
    </div>
  );
}

// 새 쪽 번호가 있으면 RIGHT, 삭제 줄이면 LEFT 가 기본 코멘트 쪽이다.
const preferredSide = (row: DiffLine): Side => (row.newLine !== null ? "RIGHT" : "LEFT");

function InlineLine({ row, index, ctx }: { row: DiffLine; index: number; ctx: Ctx }) {
  const side = preferredSide(row);
  const picked = !!ctx.selection && index >= ctx.selection.lo && index <= ctx.selection.hi && rowSide(row, ctx.selection.side) !== null;
  return (
    <div className="pr-line" role="row" data-type={row.type} data-picked={picked || undefined}>
      <GutterCell value={row.oldLine} onStart={row.oldLine === null ? undefined : () => ctx.start("LEFT", index)} onEnter={() => ctx.extend("LEFT", index)} />
      <GutterCell value={row.newLine} onStart={row.newLine === null ? undefined : () => ctx.start("RIGHT", index)} onEnter={() => ctx.extend("RIGHT", index)} />
      <button type="button" className="pr-add" aria-label={P.addCommentLine} title={`${P.addCommentLine} (${P.dragHint})`} onMouseDown={(e) => (e.preventDefault(), ctx.start(side, index))} onMouseEnter={() => ctx.extend(side, index)}>
        <Codicon name="add" size={12} />
      </button>
      <span className="pr-mark" aria-hidden="true">
        {row.type === "add" ? "+" : row.type === "del" ? "-" : ""}
      </span>
      <CodeCell segs={ctx.code[index]} index={index} side={side} />
    </div>
  );
}

function GutterCell({ value, onStart, onEnter }: { value: number | null; onStart?: () => void; onEnter: () => void }) {
  return (
    <span
      className="pr-num"
      role="cell"
      data-empty={value === null || undefined}
      onMouseDown={(e) => {
        if (onStart && e.button === 0) {
          e.preventDefault();
          onStart();
        }
      }}
      onMouseEnter={onEnter}
    >
      {value ?? ""}
    </span>
  );
}

// data-row 와 data-side 는 언어 기능이 칸을 patch 행으로 되짚는 데 쓴다(web/prLspController.ts). 삭제 줄과 옛 쪽은 LEFT 라서 기능이 붙지 않는다.
function CodeCell({ segs, index, side }: { segs: Seg[] | undefined; index: number; side: Side }) {
  return (
    <code className="pr-code" role="cell" data-row={index} data-side={side}>
      {(segs ?? []).map((seg, i) => (seg.cls ? <span key={i} className={seg.cls}>{seg.text}</span> : <Fragment key={i}>{seg.text}</Fragment>))}
    </code>
  );
}

// 줄 아래에 붙는 것들: 기존 스레드, 이 줄이 끝인 입력창
function Widgets({ index, ctx }: { index: number; ctx: Ctx }) {
  const threads = ctx.placement.byRow.get(index);
  const composing = ctx.composer && Math.max(ctx.composer.anchor, ctx.composer.head) === index ? ctx.composer : null;
  if (!threads && !composing) return null;
  return (
    <div className="pr-widgets">
      {threads?.map((thread) => (
        <PrThreadView key={thread.id} thread={thread} original={originalOf(ctx.rows, thread)} />
      ))}
      {composing && <NewThread range={composing} ctx={ctx} />}
    </div>
  );
}

function originalOf(rows: DiffRow[], thread: PrThread): string[] | undefined {
  if (thread.side !== "RIGHT" || thread.line === null) return undefined;
  return rightText(rows, thread.startLine ?? thread.line, thread.line);
}

function NewThread({ range, ctx }: { range: Range; ctx: Ctx }) {
  const busy = usePrView((v) => v.busy !== null);
  const pending = usePrView((v) => v.detail?.pendingReview ?? null);
  const actions = usePrActions();
  const lines = ctx.rows.slice(range.anchor, range.head + 1).filter((r): r is DiffLine => r.kind === "line" && rowSide(r, range.side) !== null);
  const first = lines[0] ? rowSide(lines[0], range.side) : null;
  const last = lines.length ? rowSide(lines[lines.length - 1], range.side) : null;
  if (first === null || last === null) return null;
  const submit = (mode: "single" | "review") => async (body: string) => {
    const done = await actions.createThread({ path: ctx.path, side: range.side, line: last, ...(first !== last ? { startLine: first, startSide: range.side } : {}), body, mode });
    if (done) ctx.closeComposer();
    return done;
  };
  return (
    <div className="pr-thread pr-new-thread">
      <div className="pr-thread-head">
        <Codicon name="comment" size={14} />
        <span className="pr-thread-label">{P.lineRange(first, last)}</span>
        <span className="pr-faint">{ctx.path}</span>
      </div>
      <PrComposer
        label={P.addCommentLine}
        placeholder={P.commentPlaceholder}
        busy={busy}
        autoFocus
        onCancel={ctx.closeComposer}
        suggestLines={range.side === "RIGHT" ? rightText(ctx.rows, first, last) : undefined}
        actions={
          pending
            ? [{ label: P.addReviewComment, primary: true, run: submit("review") }]
            : [
                { label: P.addSingle, run: submit("single") },
                { label: P.startReview, primary: true, run: submit("review") },
              ]
        }
      />
    </div>
  );
}

function SplitRows({ ctx, shown }: { ctx: Ctx; shown: DiffRow[] }) {
  const split = useMemo(() => toSplit(shown), [shown]);
  return (
    <>
      {split.map((entry, i) => {
        if ("hunk" in entry) {
          return (
            <Fragment key={i}>
              <HunkRow row={entry.hunk} />
            </Fragment>
          );
        }
        return (
          <Fragment key={i}>
            <SplitLine entry={entry} ctx={ctx} />
            <Widgets index={entry.leftIndex} ctx={ctx} />
            {entry.rightIndex !== entry.leftIndex && <Widgets index={entry.rightIndex} ctx={ctx} />}
          </Fragment>
        );
      })}
    </>
  );
}

function SplitLine({ entry, ctx }: { entry: SplitRow; ctx: Ctx }) {
  return (
    <div className="pr-split-line" role="row">
      <SplitHalf side="LEFT" row={entry.left} index={entry.leftIndex} ctx={ctx} />
      <SplitHalf side="RIGHT" row={entry.right} index={entry.rightIndex} ctx={ctx} />
    </div>
  );
}

function SplitHalf({ side, row, index, ctx }: { side: Side; row: DiffLine | null; index: number; ctx: Ctx }) {
  if (!row) return <div className="pr-half" data-type="gap" />;
  const picked = !!ctx.selection && ctx.selection.side === side && index >= ctx.selection.lo && index <= ctx.selection.hi;
  return (
    <div className="pr-half" data-type={row.type} data-picked={picked || undefined}>
      <GutterCell value={rowSide(row, side)} onStart={() => ctx.start(side, index)} onEnter={() => ctx.extend(side, index)} />
      <button type="button" className="pr-add" aria-label={P.addCommentLine} title={`${P.addCommentLine} (${P.dragHint})`} onMouseDown={(e) => (e.preventDefault(), ctx.start(side, index))} onMouseEnter={() => ctx.extend(side, index)}>
        <Codicon name="add" size={12} />
      </button>
      <span className="pr-mark" aria-hidden="true">
        {row.type === "add" ? "+" : row.type === "del" ? "-" : ""}
      </span>
      <CodeCell segs={ctx.code[index]} index={index} side={side} />
    </div>
  );
}

// hunk 마다 옛 쪽(ctx, del)과 새 쪽(ctx, add)을 따로 토큰화한다. patch 는 파일의 일부라서 hunk 사이는 이어 붙이지 않는다.
function highlightRows(rows: DiffRow[], path: string): Seg[][] {
  const out: Seg[][] = rows.map(() => []);
  let hunk: number[] = [];
  const flush = () => {
    for (const side of ["LEFT", "RIGHT"] as const) {
      const members = hunk.filter((i) => (rows[i] as DiffLine).type === "ctx" || (rows[i] as DiffLine).type === (side === "LEFT" ? "del" : "add"));
      const segs = highlightLines(members.map((i) => (rows[i] as DiffLine).text), path);
      members.forEach((rowIndex, k) => {
        // ctx 줄은 두 쪽에서 모두 나오는데 RIGHT 결과가 마지막에 덮는다. 삭제 줄은 LEFT 결과만 가진다.
        if ((rows[rowIndex] as DiffLine).type !== "ctx" || side === "RIGHT" || out[rowIndex].length === 0) out[rowIndex] = segs[k];
      });
    }
    hunk = [];
  };
  rows.forEach((row, i) => {
    if (row.kind === "hunk") {
      flush();
      return;
    }
    hunk.push(i);
  });
  flush();
  return out;
}
