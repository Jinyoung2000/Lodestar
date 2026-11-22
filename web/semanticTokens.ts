import { LSPPlugin } from "@codemirror/lsp-client";
import { StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";


const FALLBACK_LEGEND = {
  tokenTypes: ["class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable", "enumMember", "property", "function", "member"],
  tokenModifiers: ["declaration", "static", "async", "readonly", "defaultLibrary", "local"],
};

type Legend = { tokenTypes: string[]; tokenModifiers: string[] };

export const semanticTokensCapability = {
  clientCapabilities: {
    textDocument: {
      semanticTokens: {
        requests: { full: true },
        tokenTypes: FALLBACK_LEGEND.tokenTypes,
        tokenModifiers: FALLBACK_LEGEND.tokenModifiers,
        formats: ["relative"],
        multilineTokenSupport: false,
        overlappingTokenSupport: false,
      },
    },
  },
};

const MARKS = Object.fromEntries(
  ["type", "function", "constant", "variable"].map((kind) => [kind, Decoration.mark({ class: `cm-syn-${kind}` })]),
);

function kindFor(type: string, modifiers: ReadonlySet<string>) {
  switch (type) {
    case "class":
    case "enum":
    case "interface":
    case "namespace":
    case "typeParameter":
    case "type":
      return "type";
    case "function":
    case "member":
      return "function";
    case "enumMember":
      return "constant";
    case "variable":
    case "property":
      return modifiers.has("readonly") ? "constant" : "variable";
    case "parameter":
      return "variable";
    default:
      return null;
  }
}

const RETRIES = 3;
const RETRY_DELAY = 1500;

const received = StateEffect.define<DecorationSet>();

class SemanticTokens {
  decorations: DecorationSet = Decoration.none;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private view: EditorView) {
    this.schedule(0);
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) if (effect.is(received)) this.decorations = effect.value;
    }
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes);
      this.schedule(400);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number, attempt = 0) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.request(attempt), delay);
  }

  private async request(attempt: number) {
    const view = this.view;
    const plugin = LSPPlugin.get(view);
    if (this.destroyed) return;
    if (!plugin) {
      if (attempt < RETRIES) this.schedule(RETRY_DELAY, attempt + 1);
      return;
    }
    try {
      await plugin.client.initializing;
      plugin.client.sync();
      const doc = view.state.doc;
      const result = await plugin.client.request<object, { data: number[] } | null>("textDocument/semanticTokens/full", { textDocument: { uri: plugin.uri } });
      if (this.destroyed || view.state.doc !== doc) return;
      if (!result?.data) throw new Error("no tokens");
      const legend = ((plugin.client.serverCapabilities?.semanticTokensProvider as { legend?: Legend } | undefined)?.legend ?? FALLBACK_LEGEND) as Legend;
      view.dispatch({ effects: received.of(decode(result.data, doc, legend)) });
    } catch {
      if (attempt < RETRIES) this.schedule(RETRY_DELAY, attempt + 1);
    }
  }
}

function decode(data: number[], doc: EditorView["state"]["doc"], legend: Legend): DecorationSet {
  const ranges = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i]!;
    character = data[i]! === 0 ? character + data[i + 1]! : data[i + 1]!;
    const type = legend.tokenTypes[data[i + 3]!];
    if (!type || line + 1 > doc.lines) continue;
    const modifiers = new Set(legend.tokenModifiers.filter((_, bit) => (data[i + 4]! & (1 << bit)) !== 0));
    const kind = kindFor(type, modifiers);
    if (!kind) continue;
    const start = doc.line(line + 1);
    const from = start.from + character;
    const to = Math.min(from + data[i + 2]!, start.to);
    if (from < to) ranges.push(MARKS[kind]!.range(from, to));
  }
  return Decoration.set(ranges, true);
}

export const semanticTokens = ViewPlugin.fromClass(SemanticTokens, { decorations: (plugin) => plugin.decorations });
