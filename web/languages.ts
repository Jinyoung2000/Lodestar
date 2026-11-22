import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription, LanguageSupport, StreamLanguage, type Language, type StreamParser, type StringStream } from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { parseMixed } from "@lezer/common";
import { styleTags, tags } from "@lezer/highlight";
import { useSyncExternalStore } from "react";
import { markLanguage, refineGraphql, refineJavascript, type SyntaxGroup } from "./editorSyntax";
import { languageIdFor, languageIdForFence, mayHaveShebang, type LanguageId } from "./languageId";

export function languageFor(path: string, firstLine?: string): Extension {
  const id = languageIdFor(path, firstLine);
  if (id) {
    const ready = supportOf(id);
    return ready ?? lazyLanguage(() => id);
  }
  if (firstLine === undefined && mayHaveShebang(path)) return lazyLanguage((doc) => languageIdFor(path, doc));
  return [];
}

export function languageById(id: LanguageId | null): Language | null {
  if (!id) return null;
  const support = supportOf(id);
  if (!support) void loadLanguage(id);
  return support?.language ?? null;
}

export function languageByName(name: string): Language | null {
  return languageById(languageIdForFence(name));
}

export function loadLanguage(id: LanguageId): Promise<LanguageSupport> {
  const ready = supportOf(id);
  if (ready) return Promise.resolve(ready);
  const pending = loading.get(id);
  if (pending) return pending;
  const load = LAZY[id];
  if (!load) throw new Error(`no loader for ${id}`);
  const promise = load().then((support) => {
    cache.set(id, support);
    loading.delete(id);
    version += 1;
    for (const listener of listeners) listener();
    return support;
  });
  loading.set(id, promise);
  return promise;
}

export function subscribeLanguages(listener: () => void): () => void {
  return subscribe(listener);
}

export function useLanguagesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

const cache = new Map<LanguageId, LanguageSupport>();
const loading = new Map<LanguageId, Promise<LanguageSupport>>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function supportOf(id: LanguageId): LanguageSupport | null {
  const cached = cache.get(id);
  if (cached) return cached;
  const eager = EAGER[id];
  if (!eager) return null;
  const support = eager();
  cache.set(id, support);
  return support;
}

const EAGER: Partial<Record<LanguageId, () => LanguageSupport>> = {
  typescript: () => refineJavascript({ typescript: true }),
  typescriptreact: () => refineJavascript({ typescript: true, jsx: true }),
  javascript: () => refineJavascript(),
  javascriptreact: () => refineJavascript({ jsx: true }),
  json: () => json(),
  css: () => css(),
  markdown: () => markdown({ codeLanguages: codeBlockLanguage }),
};

function codeBlockLanguage(info: string): LanguageDescription | null {
  const id = languageIdForFence(info);
  if (!id || id === "markdown") return null;
  const known = descriptions.get(id);
  if (known) return known;
  const description = LanguageDescription.of({ name: id, load: () => loadLanguage(id) });
  descriptions.set(id, description);
  return description;
}

const descriptions = new Map<LanguageId, LanguageDescription>();

const LAZY: Partial<Record<LanguageId, () => Promise<LanguageSupport>>> = {
  yaml: async () => {
    const { yamlLanguage } = await import("@codemirror/lang-yaml");
    const language = yamlLanguage.configure({ wrap: parseMixed((node) => (node.name === "Literal" && node.node.parent?.name !== "Key" ? { parser: yamlScalar().parser } : null)) });
    return register("yaml", new LanguageSupport(language));
  },
  html: async () => {
    const { html } = await import("@codemirror/lang-html");
    return register("markup", html());
  },
  xml: async () => {
    const { xml } = await import("@codemirror/lang-xml");
    return register("markup", xml());
  },
  sql: async () => {
    const { sql } = await import("@codemirror/lang-sql");
    return register("sql", sql());
  },
  python: async () => {
    const { pythonLanguage } = await import("@codemirror/lang-python");
    const language = pythonLanguage.configure({ props: [styleTags({ "Decorator/VariableName Decorator/MemberExpression/VariableName Decorator/MemberExpression/PropertyName": tags.function(tags.variableName) })] });
    return register(null, new LanguageSupport(language));
  },
  go: async () => {
    const { go } = await import("@codemirror/lang-go");
    return register("character", go());
  },
  java: async () => {
    const { java } = await import("@codemirror/lang-java");
    return register("character", java());
  },
  kotlin: async () => {
    const { kotlin } = await import("@codemirror/legacy-modes/mode/clike");
    return register("clike", new LanguageSupport(StreamLanguage.define(kotlin)));
  },
  objectivec: async () => {
    const { objectiveC } = await import("@codemirror/legacy-modes/mode/clike");
    return register("clike", new LanguageSupport(StreamLanguage.define(objectiveC)));
  },
  swift: async () => {
    const { swift } = await import("@codemirror/legacy-modes/mode/swift");
    return register("clike", new LanguageSupport(StreamLanguage.define(swift)));
  },
  shell: shellSupport,
  makefile: shellSupport,
  dockerfile: async () => {
    const { dockerFile } = await import("@codemirror/legacy-modes/mode/dockerfile");
    return register(null, new LanguageSupport(StreamLanguage.define(dockerFile)));
  },
  toml: async () => {
    const { toml } = await import("@codemirror/legacy-modes/mode/toml");
    return register(null, new LanguageSupport(StreamLanguage.define(toml)));
  },
  properties: async () => {
    const { properties } = await import("@codemirror/legacy-modes/mode/properties");
    return register("properties", new LanguageSupport(StreamLanguage.define(properties)));
  },
  nginx: async () => {
    const { nginx } = await import("@codemirror/legacy-modes/mode/nginx");
    return register(null, new LanguageSupport(StreamLanguage.define(nginx)));
  },
  diff: async () => {
    const { diff } = await import("@codemirror/legacy-modes/mode/diff");
    return register("diff", new LanguageSupport(StreamLanguage.define(diff)));
  },
  graphql: async () => {
    const { graphqlLanguage } = await import("cm6-graphql");
    return register(null, new LanguageSupport(refineGraphql(graphqlLanguage)));
  },
  gitignore: async () => register(null, new LanguageSupport(StreamLanguage.define(gitignoreMode))),
};

function register(group: SyntaxGroup | null, support: LanguageSupport): LanguageSupport {
  if (group) markLanguage(group, support.language);
  return support;
}

function lazyLanguage(idOf: (firstLine: string) => LanguageId | null): Extension {
  const slot = new Compartment();
  const plugin = ViewPlugin.fromClass(
    class {
      private id: LanguageId | null;
      private destroyed = false;
      constructor(private view: EditorView) {
        this.id = idOf(view.state.doc.line(1).text);
        if (this.id) void this.attach(this.id);
      }
      destroy() {
        this.destroyed = true;
      }
      private async attach(id: LanguageId) {
        const support = await loadLanguage(id);
        if (this.destroyed) return;
        this.view.dispatch({ effects: slot.reconfigure(support) });
      }
    },
  );
  return [slot.of([]), plugin];
}

const YAML_BOOLEAN = /^(?:true|false|yes|no|on|off)$/i;
const YAML_NULL = /^(?:null|~)$/i;
const YAML_NUMBER = /^(?:[-+]?(?:\d[\d_]*)(?:\.\d+)?(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|[-+]?\.(?:inf|nan))$/i;

let scalar: StreamLanguage<null> | null = null;
function yamlScalar(): StreamLanguage<null> {
  scalar ??= StreamLanguage.define<null>({
    name: "yaml-scalar",
    token(stream) {
      if (stream.eatSpace()) return null;
      stream.skipToEnd();
      const word = stream.current();
      if (YAML_BOOLEAN.test(word) || YAML_NULL.test(word)) return "atom";
      return YAML_NUMBER.test(word) ? "number" : "string";
    },
  });
  return scalar;
}

type ShellState = { tokens: unknown[]; command: boolean; continued: boolean; assignment: boolean };
const COMMAND_WORD = /^[\w./~+-][\w./~+:@%-]*$/;
const CONTROL_WORDS = new Set(["if", "then", "do", "else", "elif", "while", "until", "time", "!"]);

async function shellSupport(): Promise<LanguageSupport> {
  const { shell } = await import("@codemirror/legacy-modes/mode/shell");
  const base = shell.token as (stream: StringStream, state: unknown) => string | null;
  const mode: StreamParser<ShellState> = {
    name: "shell",
    languageData: shell.languageData,
    tokenTable: { command: tags.function(tags.variableName) },
    startState: () => ({ tokens: [], command: true, continued: false, assignment: false }),
    token(stream, state) {
      if (stream.sol()) {
        if (!state.continued && state.tokens.length === 0) state.command = true;
        state.continued = false;
      }
      const style = base(stream, state);
      const text = stream.current();
      if (/^\s*$/.test(text)) return null;
      if (text === "\\" && stream.eol()) state.continued = true;
      if (style === "quote") return null;
      if (state.tokens.length > 0) return style;
      if (state.assignment) {
        if (text === "=") return style;
        state.assignment = false;
        if (style === null && COMMAND_WORD.test(text)) return null;
      }
      if (style === null) {
        if (/^[|&;({`]+$/.test(text) || CONTROL_WORDS.has(text)) {
          state.command = true;
          return null;
        }
        const isCommand = state.command && COMMAND_WORD.test(text);
        state.command = false;
        return isCommand ? "command" : null;
      }
      if (style === "keyword" && CONTROL_WORDS.has(text)) return style;
      if (style === "def" && stream.peek() === "=") {
        state.assignment = true;
        return style;
      }
      const isCommand = style === "builtin" && state.command;
      state.command = false;
      return style === "builtin" ? (isCommand ? "command" : null) : style;
    },
  };
  return register("shell", new LanguageSupport(StreamLanguage.define(mode)));
}

const gitignoreMode: StreamParser<null> = {
  name: "gitignore",
  startState: () => null,
  languageData: { commentTokens: { line: "#" } },
  token(stream) {
    if (stream.sol() && stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.eat("!")) return "operator";
    if (stream.match(/^[0-9a-f]{7,40}(?=\s|$)/i)) return "number";
    if (stream.eat("*")) {
      stream.eatWhile("*");
      return "operator";
    }
    if (stream.eat("?")) return "operator";
    if (stream.peek() === "[" && stream.match(/^\[[^\]\s]*\]/)) return "regexp";
    if (stream.eatSpace()) return null;
    const start = stream.pos;
    stream.eatWhile(/[^*?[\s]/);
    if (stream.pos === start) stream.next();
    return null;
  },
};
