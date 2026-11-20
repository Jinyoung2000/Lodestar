import "./scm.css";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import { parseConflicts, replacementFor, type ConflictBlock, type ConflictChoice } from "../shared/conflicts";
import { M } from "./scmStrings";


const MAX_SCAN = 5_000_000;

function blocksOf(state: EditorState): ConflictBlock[] {
  const text = state.doc;
  // 마커가 한 번도 안 나오는 흔한 파일은 줄 배열을 만들지 않는다. 아주 큰 파일은 건너뛴다.
  if (text.length > MAX_SCAN || !text.sliceString(0).includes("<<<<<<<")) return [];
  return parseConflicts(Array.from(text.iterLines()));
}

export function conflictBlocks(state: EditorState): ConflictBlock[] {
  return state.field(conflictField, false)?.blocks ?? [];
}

type Info = { blocks: ConflictBlock[]; decorations: DecorationSet };

const conflictField = StateField.define<Info>({
  create: (state) => build(state),
  update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field, (info) => info.decorations),
});

const lineClass = (name: string) => Decoration.line({ class: `cm-conflict-line ${name}` });
const LINES = {
  marker: lineClass("cm-conflict-marker"),
  current: lineClass("cm-conflict-current"),
  base: lineClass("cm-conflict-base"),
  incoming: lineClass("cm-conflict-incoming"),
};

function build(state: EditorState): Info {
  const blocks = blocksOf(state);
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  blocks.forEach((block, index) => {
    // 줄 번호는 1부터. 위젯은 시작 줄 위에 한 번, 줄 장식은 위에서 아래로 차례로 넣는다.
    builder.add(doc.line(block.start + 1).from, doc.line(block.start + 1).from, Decoration.widget({ widget: new ConflictActions(index, block), block: true, side: -1 }));
    for (let line = block.start; line <= block.end; line++) {
      const kind = line === block.start || line === block.mid || line === block.end || line === block.base ? LINES.marker : line < (block.base >= 0 ? block.base : block.mid) ? LINES.current : block.base >= 0 && line < block.mid ? LINES.base : LINES.incoming;
      builder.add(doc.line(line + 1).from, doc.line(line + 1).from, kind);
    }
  });
  return { blocks, decorations: builder.finish() };
}

class ConflictActions extends WidgetType {
  constructor(
    readonly index: number,
    readonly block: ConflictBlock,
  ) {
    super();
  }

  eq(other: ConflictActions) {
    return other.index === this.index && other.block.currentLabel === this.block.currentLabel && other.block.incomingLabel === this.block.incomingLabel;
  }

  // 단추는 편집기 줄 높이를 밀어내는 블록 위젯이다. 이벤트는 편집기로 넘기지 않는다.
  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    const row = document.createElement("div");
    row.className = "cm-conflict-actions";
    const add = (choice: ConflictChoice, label: string, title: string) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-conflict-button";
      button.textContent = label;
      button.title = title;
      button.dataset.choice = choice;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => resolveBlock(view, this.index, choice));
      row.append(button);
    };
    add("current", M.acceptCurrent, M.currentSide(this.block.currentLabel));
    add("incoming", M.acceptIncoming, M.incomingSide(this.block.incomingLabel));
    add("both", M.acceptBoth, `${M.currentSide(this.block.currentLabel)} + ${M.incomingSide(this.block.incomingLabel)}`);
    return row;
  }
}

// 블록 하나를 고른 쪽 내용으로 바꾼다. 위젯이 만들어진 뒤 문서가 바뀌었을 수 있으니 번호는 지금 문서에서 다시 찾는다.
export function resolveBlock(view: EditorView, index: number, choice: ConflictChoice) {
  const block = conflictBlocks(view.state)[index];
  if (!block) return;
  const doc = view.state.doc;
  const first = doc.line(block.start + 1);
  const last = doc.line(block.end + 1);
  const replacement = replacementFor(block, choice);
  if (replacement.length > 0) {
    view.dispatch({ changes: { from: first.from, to: last.to, insert: replacement.join("\n") }, userEvent: "input.conflict" });
    return;
  }
  // 고른 쪽이 비어 있으면 블록이 줄째 사라진다. 빈 줄이 남지 않게 줄바꿈 하나를 같이 지운다.
  const from = last.number < doc.lines ? first.from : Math.max(0, first.from - 1);
  const to = last.number < doc.lines ? last.to + 1 : last.to;
  view.dispatch({ changes: { from, to }, userEvent: "input.conflict" });
}

// 다음 또는 이전 충돌의 시작 줄로 간다. 끝에서 넘기면 반대쪽 끝으로 돈다.
export function gotoConflict(view: EditorView, direction: 1 | -1) {
  const blocks = conflictBlocks(view.state);
  if (blocks.length === 0) return;
  const head = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  const target = direction === 1 ? (blocks.find((b) => b.start > head) ?? blocks[0]) : ([...blocks].reverse().find((b) => b.end < head && b.start < head) ?? blocks[blocks.length - 1]);
  const line = view.state.doc.line(target.start + 1);
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 48 }) });
  view.focus();
}

// --- 충돌 개수: 머리 띠가 읽는다 ---

const counts = new Map<string, number>();
const listeners = new Set<() => void>();

function setCount(key: string, count: number) {
  if ((counts.get(key) ?? 0) === count) return;
  if (count === 0) counts.delete(key);
  else counts.set(key, count);
  for (const listener of listeners) listener();
}

export function useConflictCount(key: string): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => counts.get(key) ?? 0,
  );
}

export function conflictExtension(tabKey: string): Extension {
  return [
    conflictField,
    ViewPlugin.define((view) => {
      setCount(tabKey, conflictBlocks(view.state).length);
      return {
        update(update) {
          if (update.docChanged) setCount(tabKey, conflictBlocks(update.state).length);
        },
        destroy() {
          setCount(tabKey, 0);
        },
      };
    }),
  ];
}
