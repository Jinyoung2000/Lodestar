import { LSPPlugin } from "@codemirror/lsp-client";
import { EditorView } from "@codemirror/view";
import { diagnosticLabel, diagnosticsOf, type LspDiagnostic } from "./diagnosticsStore";
import { toTarget, uriToPath } from "./lsp";
import { splitPath } from "./peekModel";
import { peekOptions } from "./peekView";
import { currentZone, hideZone, showZone, type ZoneParts } from "./peekZone";
import { openFile } from "./store";
import { S } from "./strings";
import "./markerView.css";
import { hint } from "./hint";


type Problem = { diagnostic: LspDiagnostic; from: number; to: number; severity: 1 | 2 | 3 };

const KIND = { 1: "error", 2: "warning", 3: "info" } as const;
const sessions = new WeakMap<EditorView, { problems: Problem[]; index: number }>();

export function sortedProblems(view: EditorView): Problem[] {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return [];
  const problems: Problem[] = [];
  for (const diagnostic of diagnosticsOf(plugin.uri)) {
    const severity = diagnostic.severity ?? 1;
    if (severity > 3) continue;
    const from = plugin.unsyncedChanges.mapPos(plugin.fromPosition(diagnostic.range.start, plugin.syncedDoc));
    const to = plugin.unsyncedChanges.mapPos(plugin.fromPosition(diagnostic.range.end, plugin.syncedDoc));
    problems.push({ diagnostic, from, to, severity: severity as 1 | 2 | 3 });
  }
  return problems.sort((a, b) => a.severity - b.severity || a.from - b.from || a.to - b.to);
}

export function initialIndex(ranges: { from: number; to: number }[], head: number, forward: boolean): number {
  let index = -1;
  let containing = false;
  for (let i = 0; i < ranges.length; i++) {
    const { from, to } = ranges[i];
    if ((head >= from && head <= to) || head <= from) {
      index = i;
      containing = head >= from && head <= to;
      break;
    }
  }
  if (index === -1) index = forward ? 0 : ranges.length - 1;
  else if (!containing && !forward) index -= 1;
  return index < 0 ? ranges.length - 1 : index;
}

export function gotoProblem(view: EditorView, direction: 1 | -1) {
  const problems = sortedProblems(view);
  if (!problems.length) {
    hint(S.noProblems, view);
    return;
  }
  const session = sessions.get(view);
  const open = currentZone(view)?.className.includes("cm-marker") && session && session.problems.length === problems.length;
  let index: number;
  if (open) index = (session.index + direction + problems.length) % problems.length;
  else {
    index = initialIndex(problems, view.state.selection.main.head, direction === 1);
  }
  showProblem(view, problems, index);
}

export function viewProblem(view: EditorView, diagnostic: LspDiagnostic) {
  const problems = sortedProblems(view);
  const index = problems.findIndex((p) => p.diagnostic === diagnostic || (p.diagnostic.message === diagnostic.message && p.diagnostic.range.start.line === diagnostic.range.start.line && p.diagnostic.range.start.character === diagnostic.range.start.character));
  if (index === -1) {
    hint(S.noProblems, view);
    return;
  }
  showProblem(view, problems, index);
}

let counter = 0;

function showProblem(view: EditorView, problems: Problem[], index: number) {
  const problem = problems[index];
  const head = view.state.selection.main.head;
  const at = head >= problem.from && head <= problem.to ? head : problem.from;
  const related = problem.diagnostic.relatedInformation ?? [];
  const messageLines = problem.diagnostic.message.split("\n").length;
  const lines = 3 + Math.min(17, messageLines + (related.length ? 1 + related.length : 0));
  sessions.set(view, { problems, index });
  showZone(view, {
    id: 1_000_000 + ++counter,
    anchor: at,
    arrowAt: at,
    lines,
    className: `cm-marker cm-marker-${KIND[problem.severity]}`,
    mount: (parts) => mountProblem(parts, view, problems, index),
  });
  view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "nearest", yMargin: 40 }) });
}

function mountProblem(parts: ZoneParts, view: EditorView, problems: Problem[], index: number) {
  const problem = problems[index];
  const { diagnostic } = problem;
  const plugin = LSPPlugin.get(view);
  const kind = KIND[problem.severity];

  const icon = document.createElement("span");
  icon.className = `codicon codicon-${kind} cm-marker-icon`;
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "cm-zone-name";
  name.textContent = plugin ? splitPath(uriToPath(plugin.uri)).name : "";
  const meta = document.createElement("span");
  meta.className = "cm-zone-dir";
  meta.textContent = S.markerCount(index + 1, problems.length);
  parts.title.append(icon, name, meta);

  const button = (codicon: string, label: string, run: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "cm-zone-action";
    node.title = label;
    node.setAttribute("aria-label", label);
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${codicon}`;
    node.append(glyph);
    node.addEventListener("mousedown", (event) => event.preventDefault());
    node.addEventListener("click", () => {
      run();
      view.focus();
    });
    parts.actions.append(node);
  };
  button("arrow-down", S.markerNext, () => gotoProblem(view, 1));
  button("arrow-up", S.markerPrevious, () => gotoProblem(view, -1));
  button("close", S.close, () => hideZone(view));

  const scroller = document.createElement("div");
  scroller.className = "cm-marker-body";
  const message = document.createElement("div");
  message.className = "cm-marker-message";
  message.setAttribute("role", "alert");
  const rows = diagnostic.message.split("\n");
  let last: HTMLElement | null = null;
  for (const row of rows) {
    last = document.createElement("div");
    last.textContent = row;
    if (row === "") last.style.height = "var(--editor-line-height)";
    message.append(last);
  }
  const label = diagnosticLabel(diagnostic);
  if (label && last) {
    const details = document.createElement("span");
    details.className = "cm-marker-details";
    details.textContent = label;
    last.append(details);
  }
  scroller.append(message);

  const related = diagnostic.relatedInformation ?? [];
  if (related.length) {
    const block = document.createElement("div");
    block.className = "cm-marker-related";
    for (const item of related) {
      const row = document.createElement("div");
      const target = toTarget(uriToPath(item.location.uri), view.state.facet(peekOptions)?.workspaceId ?? "");
      const link = document.createElement("a");
      link.className = "cm-marker-link";
      link.textContent = `${splitPath(target.path).name}(${item.location.range.start.line + 1}, ${item.location.range.start.character + 1}): `;
      link.title = target.path;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        hideZone(view, { refocus: false });
        openFile({ ...target, line: item.location.range.start.line + 1, column: item.location.range.start.character + 1 });
      });
      const text = document.createElement("span");
      text.textContent = item.message;
      row.append(link, text);
      block.append(row);
    }
    scroller.append(block);
  }
  parts.body.append(scroller);
  return () => {};
}
