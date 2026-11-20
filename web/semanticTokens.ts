import { LSPPlugin } from "@codemirror/lsp-client";
import { StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";


// 서버가 initialize 결과에 legend 를 주지만, 못 받았을 때 쓰는 typescript-language-server 6 의 값
const FALLBACK_LEGEND = {
  tokenTypes: ["class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable", "enumMember", "property", "function", "member"],
  tokenModifiers: ["declaration", "static", "async", "readonly", "defaultLibrary", "local"],
};

type Legend = { tokenTypes: string[]; tokenModifiers: string[] };

// LSPClient 를 만들 때 extensions 에 넣는다. 서버에 "토큰 요청을 보낼 수 있다" 고 알리는 클라이언트 기능 선언이다.
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
    // LSPPlugin 은 이 플러그인과 같은 때에 만들어지므로 한 틱 뒤에 찾는다.
    this.schedule(0);
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) if (effect.is(received)) this.decorations = effect.value;
    }
    if (update.docChanged) {
      // 서버가 새 응답을 줄 때까지 기존 장식을 본문 변경에 맞춰 옮긴다.
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

  // 프로젝트를 아직 읽는 중이면 서버가 실패나 빈 응답을 줄 수 있어 몇 번 다시 묻는다.
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
      // 기다리는 사이 본문이 바뀌었거나 에디터가 닫혔으면 버린다(바뀐 쪽의 요청이 따로 뒤따른다).
      if (this.destroyed || view.state.doc !== doc) return;
      if (!result?.data) throw new Error("no tokens");
      const legend = ((plugin.client.serverCapabilities?.semanticTokensProvider as { legend?: Legend } | undefined)?.legend ?? FALLBACK_LEGEND) as Legend;
      view.dispatch({ effects: received.of(decode(result.data, doc, legend)) });
    } catch {
      // 끝내 못 받아도 Lezer 색이 그대로 보이므로 조용히 둔다.
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
