import "./scm.css";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import { parseConflicts, replacementFor, type ConflictBlock, type ConflictChoice } from "../shared/conflicts";
import { M } from "./scmStrings";


const MAX_SCAN = 5_000_000;

function blocksOf(state: EditorState): ConflictBlock[] {
  const text = state.doc;
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
  const from = last.number < doc.lines ? first.from : Math.max(0, first.from - 1);
  const to = last.number < doc.lines ? last.to + 1 : last.to;
  view.dispatch({ changes: { from, to }, userEvent: "input.conflict" });
}

export function gotoConflict(view: EditorView, direction: 1 | -1) {
  const blocks = conflictBlocks(view.state);
  if (blocks.length === 0) return;
  const head = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  const target = direction === 1 ? (blocks.find((b) => b.start > head) ?? blocks[0]) : ([...blocks].reverse().find((b) => b.end < head && b.start < head) ?? blocks[blocks.length - 1]);
  const line = view.state.doc.line(target.start + 1);
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 48 }) });
  view.focus();
}

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
