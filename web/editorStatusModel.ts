import type { EditorState } from "@codemirror/state";

export type StatusItems = { selection: string; indentation: string; encoding: string; eol: string; language: string };

export type StatusIndent = { useSpaces: boolean; size: number };

export function statusItems(state: EditorState, file: { path: string | null }, indent: StatusIndent): StatusItems {
  return {
    selection: selectionLabel(state),
    indentation: indentationLabel(indent),
    encoding: "UTF-8",
    eol: state.lineBreak === "\r\n" ? "CRLF" : "LF",
    language: languageName(file.path),
  };
}

export function selectionLabel(state: EditorState): string {
  const ranges = state.selection.ranges;
  const selected = ranges.reduce((sum, range) => sum + characterCount(state.sliceDoc(range.from, range.to)), 0);
  if (ranges.length === 1) {
    const head = ranges[0]!.head;
    const line = state.doc.lineAt(head);
    const where = `Ln ${line.number}, Col ${statusColumn(line.text, head - line.from, state.tabSize)}`;
    return selected ? `${where} (${selected} selected)` : where;
  }
  return selected ? `${ranges.length} selections (${selected} characters selected)` : `${ranges.length} selections`;
}

function characterCount(text: string) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

export function statusColumn(lineText: string, offsetInLine: number, tabSize: number): number {
  let column = 0;
  for (const char of lineText.slice(0, offsetInLine)) column = char === "\t" ? column + tabSize - (column % tabSize) : column + 1;
  return column + 1;
}

export function indentationLabel(indent: StatusIndent): string {
  return indent.useSpaces ? `Spaces: ${indent.size}` : `Tab Size: ${indent.size}`;
}

export const STATUS_TOOLTIPS = { selection: "Go to Line/Column", indentation: "Select Indentation", encoding: "Select Encoding", eol: "Select End of Line Sequence", language: "Select Language Mode" } as const;

const BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript", mts: "TypeScript", cts: "TypeScript", tsx: "TypeScript JSX",
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript JSX",
  json: "JSON", webmanifest: "JSON", jsonc: "JSON with Comments", json5: "JSON with Comments", "code-workspace": "JSON with Comments", jsonl: "JSON Lines",
  css: "CSS", scss: "SCSS", less: "Less",
  md: "Markdown", markdown: "Markdown", mdx: "Markdown",
  yml: "YAML", yaml: "YAML",
  sh: "Shell Script", bash: "Shell Script", zsh: "Shell Script", ksh: "Shell Script", command: "Shell Script",
  html: "HTML", htm: "HTML", xhtml: "HTML", ejs: "HTML",
  xml: "XML", svg: "XML", xsd: "XML", plist: "XML", csproj: "XML", xsl: "XSL", xslt: "XSL",
  sql: "MS SQL",
  py: "Python", pyi: "Python", pyw: "Python",
  ini: "Ini", cfg: "Properties", conf: "Properties", properties: "Properties", editorconfig: "Properties",
  go: "Go", java: "Java", swift: "Swift", rs: "Rust", rb: "Ruby", php: "PHP", lua: "Lua", dart: "Dart", cs: "C#", c: "C", h: "C++", cpp: "C++", cc: "C++", hpp: "C++", m: "Objective-C", mm: "Objective-C++",
  kt: "Kotlin", kts: "Kotlin", toml: "TOML", graphql: "GraphQL", gql: "GraphQL", graphqls: "GraphQL",
  diff: "Diff", patch: "Diff", log: "Log", env: "Dotenv", bat: "Batch", cmd: "Batch", ps1: "PowerShell", mk: "Makefile", mak: "Makefile",
};
const BY_NAME: Record<string, string> = {
  dockerfile: "Docker", containerfile: "Docker", makefile: "Makefile", gnumakefile: "Makefile",
  ".gitignore": "Ignore", ".dockerignore": "ignore", ".npmignore": "ignore", ".gitattributes": "Properties", ".gitmodules": "Properties", ".editorconfig": "Properties", ".npmrc": "properties", ".env": "Dotenv",
  "tsconfig.json": "JSON with Comments", "jsconfig.json": "JSON with Comments", "settings.json": "JSON with Comments", "launch.json": "JSON with Comments", "tasks.json": "JSON with Comments",
  "package.json": "JSON",
};
const PLAIN_TEXT = "Plain Text";

export function languageName(path: string | null): string {
  if (!path) return PLAIN_TEXT;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  if (name.startsWith(".env.")) return "Dotenv";
  const dot = name.lastIndexOf(".");
  return (dot === -1 ? undefined : BY_EXTENSION[name.slice(dot + 1)]) ?? PLAIN_TEXT;
}
