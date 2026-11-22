import { completionStatus, insertCompletionText, selectedCompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { LSPClient, LSPPlugin, type serverCompletionSource } from "@codemirror/lsp-client";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

type TextEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
type Documentation = string | { kind: "plaintext" | "markdown"; value: string };
type Item = { label: string; kind?: number; detail?: string; documentation?: Documentation; additionalTextEdits?: TextEdit[]; data?: unknown };
type Capture = { items: Item[] | null };
type Resolved = { value: Item | null; promise: Promise<Item> };

let capture: Capture | null = null;

export class ResolvingClient extends LSPClient {
  request<Params, Result>(method: string, params: Params): Promise<Result> {
    const target = capture;
    const result = super.request<Params, Result>(method, params);
    if (method === "textDocument/completion" && target) {
      result.then(
        (response) => {
          const list = response as Item[] | { items: Item[] } | null;
          target.items = Array.isArray(list) ? list : (list?.items ?? null);
        },
        () => {},
      );
    }
    return result;
  }
}

export const resolveSupport = {
  clientCapabilities: { textDocument: { completion: { completionItem: { resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } } } } },
};

export function resolvingSource(source: typeof serverCompletionSource): CompletionSource {
  return async (context) => {
    const mine: Capture = { items: null };
    capture = mine;
    const pending = source(context);
    capture = null;
    const result = await pending;
    const plugin = context.view && LSPPlugin.get(context.view);
    if (!result || !plugin || !mine.items || mine.items.length !== result.options.length) return result;
    const items = mine.items;
    return { ...result, options: result.options.map((option, i) => withResolve(plugin, option, items[i])) };
  };
}

const resolved = new WeakMap<Item, Resolved>();
const itemOf = new WeakMap<Completion, { plugin: LSPPlugin; item: Item }>();

function resolveItem(plugin: LSPPlugin, item: Item): Resolved {
  const known = resolved.get(item);
  if (known) return known;
  const entry: Resolved = { value: null, promise: Promise.resolve(item) };
  resolved.set(item, entry);
  if (plugin.client.serverCapabilities?.completionProvider?.resolveProvider) {
    entry.promise = plugin.client.request<Item, Item>("completionItem/resolve", item).then(
      (full) => (entry.value = { ...item, ...full }),
      () => (entry.value = item),
    );
  } else entry.value = item;
  return entry;
}

function withResolve(plugin: LSPPlugin, option: Completion, item: Item): Completion {
  const insert = option.apply;
  const resolvesEdits = !item.additionalTextEdits;
  const resolved: Completion = {
    ...option,
    ...(item.kind ? { type: lspTypeOf(item.kind) } : {}),
    info: () => infoNode(plugin, item),
    apply: (view, completion, from, to) => {
      const before = view.state.doc;
      if (typeof insert === "function") insert(view, completion, from, to);
      else view.dispatch(insertCompletionText(view.state, typeof insert === "string" ? insert : completion.label, from, to));
      if (!resolvesEdits) return;
      const inserted = view.state.doc;
      const delta = inserted.length - before.length;
      const entry = resolveItem(plugin, item);
      const finish = (full: Item) => {
        if (!full.additionalTextEdits?.length || view.state.doc !== inserted) return;
        const changes = full.additionalTextEdits.flatMap((edit) => {
          const start = plugin.fromPosition(edit.range.start, before);
          const end = plugin.fromPosition(edit.range.end, before);
          if (end <= from) return [{ from: start, to: end, insert: edit.newText }];
          if (start >= to) return [{ from: start + delta, to: end + delta, insert: edit.newText }];
          return [];
        });
        if (changes.length) view.dispatch({ changes, userEvent: "input.complete" });
      };
      if (entry.value) finish(entry.value);
      else void entry.promise.then(finish);
    },
  };
  itemOf.set(resolved, { plugin, item });
  return resolved;
}

async function infoNode(plugin: LSPPlugin, item: Item): Promise<Node | null> {
  const full = await resolveItem(plugin, item).promise;
  if (!full.detail && !full.documentation) return null;
  const root = document.createElement("div");
  root.className = "cm-lsp-documentation cm-lsp-completion-documentation";
  if (full.detail) {
    const detail = document.createElement("pre");
    detail.className = "cm-completion-signature";
    detail.textContent = full.detail;
    root.appendChild(detail);
  }
  if (full.documentation) {
    const docs = document.createElement("div");
    docs.innerHTML = plugin.docToHTML(full.documentation);
    root.appendChild(docs);
  }
  return root;
}


const STORAGE_KEY = "expandSuggestionDocs";
const setDetails = StateEffect.define<boolean>();

const detailsOpen = StateField.define<boolean>({
  create: readStored,
  update: (value, tr) => tr.effects.reduce((acc, effect) => (effect.is(setDetails) ? effect.value : acc), value),
  provide: (field) => EditorView.editorAttributes.from(field, (open) => ({ class: open ? "" : "cm-suggest-details-off" })),
});

export function suggestDetails(): Extension {
  return [detailsOpen, inlineDetailListener];
}

export function toggleSuggestionDetails(view: EditorView) {
  if (completionStatus(view.state) !== "active") return false;
  const next = !view.state.field(detailsOpen, false);
  view.dispatch({ effects: setDetails.of(next) });
  writeStored(next);
  return true;
}

export function toggleDetailsFromKey(focused: Element | null) {
  const dom = focused?.closest<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  return view ? toggleSuggestionDetails(view) : false;
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStored(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(open));
  } catch {
  }
}

const KIND_TYPES: Record<number, string> = {
  1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field", 6: "variable", 7: "class", 8: "interface", 9: "module", 10: "property", 11: "unit", 12: "value", 13: "enum", 14: "keyword", 15: "snippet", 16: "color", 17: "file", 18: "reference", 19: "folder", 20: "enumMember", 21: "constant", 22: "struct", 23: "event", 24: "operator", 25: "typeParameter",
};

export function lspTypeOf(kind: number): string {
  return KIND_TYPES[kind] ?? "text";
}

const inlineSpans = new WeakMap<Completion, { detail: HTMLElement; more: HTMLElement }>();

export const completionRowExtras = [
  {
    position: 90,
    render(completion: Completion, _state: unknown, view: EditorView): Node | null {
      const known = itemOf.get(completion);
      if (!known) return null;
      const root = document.createElement("span");
      root.className = "cm-completionRowExtras";
      const detail = document.createElement("span");
      detail.className = "cm-completionInlineDetail";
      const more = document.createElement("span");
      more.className = "cm-completionReadMore codicon codicon-info";
      more.title = "Read More (⌃Space)";
      more.setAttribute("aria-label", "Read More");
      more.addEventListener("mousedown", (event) => event.preventDefault());
      more.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSuggestionDetails(view);
      });
      root.append(detail, more);
      inlineSpans.set(completion, { detail, more });
      const cached = resolved.get(known.item)?.value;
      if (cached) fillExtras(completion, cached);
      return root;
    },
  },
];

function fillExtras(completion: Completion, full: Item) {
  const spans = inlineSpans.get(completion);
  if (!spans) return;
  const first = full.detail?.split("\n")[0];
  if (first && !completion.detail) spans.detail.textContent = first;
  if (full.detail || full.documentation) spans.more.dataset.hasInfo = "";
  const refined = first ? kindFromDetail(first) : null;
  const icon = spans.detail.closest("li")?.querySelector<HTMLElement>(".cm-completionIcon");
  if (refined && icon) icon.className = `cm-completionIcon cm-completionIcon-${refined}`;
}

const DETAIL_KINDS: Record<string, string> = { function: "function", class: "class", interface: "interface", enum: "enum", type: "class", namespace: "module", module: "module", const: "variable", let: "variable", var: "variable", method: "method", property: "property" };

export function kindFromDetail(detail: string): string | null {
  const prefix = /^\(([^)]*)\)\s+/.exec(detail);
  const label = prefix?.[1] ?? "";
  if (/^(method)$/.test(label)) return "method";
  if (/^(property)$/.test(label)) return "property";
  if (/^(local var|local const|var|let|const|parameter)$/.test(label)) return "variable";
  const match = /^(?:(?:abstract|declare|export|default)\s+)*(function|class|interface|enum|type|namespace|module|const|let|var|method|property)\b/.exec(prefix ? detail.slice(prefix[0].length) : detail);
  return match ? (DETAIL_KINDS[match[1]!] ?? null) : null;
}

const inlineDetailListener = EditorView.updateListener.of((update) => {
  const now = selectedCompletion(update.state);
  const before = selectedCompletion(update.startState);
  if (!now || now === before) return;
  const known = itemOf.get(now);
  if (!known) return;
  void resolveItem(known.plugin, known.item).promise.then((full) => fillExtras(now, full));
});
