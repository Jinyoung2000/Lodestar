export type FocusGuardResult = { action: "pass" } | { action: "rewrite"; command: string; opens: string[] } | { action: "deny"; reason: string; matched: string };

export const FOCUS_DENY_REASON = "사용자의 포커스와 입력을 뺏는 명령이라 막았다. 창을 앞으로 가져오지 말고 CDP/API 로 조작하라";

type Token = { value: string; start: number; end: number };
type Segment = { tokens: Token[]; end: number };

export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let tokens: Token[] = [];
  let value = "";
  let start = -1;
  const flushToken = (end: number) => {
    if (start >= 0) tokens.push({ value, start, end });
    value = "";
    start = -1;
  };
  const flushSegment = (end: number) => {
    flushToken(end);
    if (tokens.length) segments.push({ tokens, end });
    tokens = [];
  };
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && command[i - 1] !== "<") {
      const heredoc = readHeredocStart(command, i + 2);
      if (heredoc) {
        flushToken(i);
        heredocs.push(heredoc);
        i = heredoc.next;
        continue;
      }
    }
    if (c === "\n" && heredocs.length) {
      flushSegment(i);
      i = skipHeredocBodies(command, i + 1, heredocs.splice(0));
      continue;
    }
    if (c === "'") {
      if (start < 0) start = i;
      const close = command.indexOf("'", i + 1);
      const stop = close < 0 ? command.length : close;
      value += command.slice(i + 1, stop);
      i = close < 0 ? command.length : close + 1;
      continue;
    }
    if (c === '"') {
      if (start < 0) start = i;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          const next = command[i + 1];
          value += next === '"' || next === "\\" || next === "$" || next === "`" ? next : `\\${next}`;
          i += 2;
        } else value += command[i++];
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      if (start < 0) start = i;
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      value += command[i + 1];
      i += 2;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      flushSegment(i);
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      flushToken(i);
      i++;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")" || c === "`") {
      flushSegment(i);
      i++;
      continue;
    }
    if (c === "&") {
      const prev = command[i - 1];
      if (prev === ">" || prev === "<" || command[i + 1] === ">") {
        if (start < 0) start = i;
        value += c;
        i++;
        continue;
      }
      flushSegment(i);
      i++;
      continue;
    }
    if (c === "#" && start < 0) {
      flushSegment(i);
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    if (start < 0) start = i;
    value += c;
    i++;
  }
  flushSegment(command.length);
  return segments;
}

function readHeredocStart(command: string, from: number): { delimiter: string; stripTabs: boolean; next: number } | null {
  let at = from;
  const stripTabs = command[at] === "-";
  if (stripTabs) at++;
  while (command[at] === " " || command[at] === "\t") at++;
  const quote = command[at];
  if (quote === "'" || quote === '"') {
    const close = command.indexOf(quote, at + 1);
    if (close < 0) return null;
    return { delimiter: command.slice(at + 1, close), stripTabs, next: close + 1 };
  }
  const word = /^\\?([A-Za-z0-9_.-]+)/.exec(command.slice(at));
  return word ? { delimiter: word[1], stripTabs, next: at + word[0].length } : null;
}

function skipHeredocBodies(command: string, from: number, heredocs: { delimiter: string; stripTabs: boolean }[]): number {
  let at = from;
  for (const { delimiter, stripTabs } of heredocs) {
    while (at < command.length) {
      const lineEnd = command.indexOf("\n", at);
      const end = lineEnd < 0 ? command.length : lineEnd;
      const line = command.slice(at, end);
      at = end + 1;
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
    }
  }
  return Math.min(at, command.length);
}

const RESERVED = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "time", "nohup", "command", "exec", "builtin", "sudo", "nice", "caffeinate"]);
const XARGS_WITH_VALUE = new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-J", "-R", "-S"]);
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function commandIndex(tokens: Token[]): number {
  let i = 0;
  while (i < tokens.length) {
    const word = tokens[i].value;
    if (RESERVED.has(word) || isAssignment(word)) {
      i++;
      continue;
    }
    if (word === "env") {
      i++;
      while (i < tokens.length && (isAssignment(tokens[i].value) || tokens[i].value.startsWith("-"))) i++;
      continue;
    }
    if (word === "xargs") {
      i++;
      while (i < tokens.length && tokens[i].value.startsWith("-")) i += XARGS_WITH_VALUE.has(tokens[i].value) ? 2 : 1;
      continue;
    }
    return i;
  }
  return -1;
}

const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

function openHasBackground(args: Token[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i].value;
    if (word === "--args") return false;
    if (word === "--background") return true;
    if (/^-[A-Za-z]+$/.test(word)) {
      if (word.includes("g")) return true;
      if (/[abs]/.test(word)) i++;
    }
  }
  return false;
}

const unquoteScript = (tokens: Token[]) => tokens.map((t) => t.value).join("\n");

const stripStrings = (script: string) => script.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");

const APPLESCRIPT_FOCUS = /\b(activate|reopen|frontmost|keystroke|key\s+code|key\s+down|key\s+up|click|perform\s+action|AXRaise|AXPress)\b/i;
const JXA_FOCUS = /\.(activate\w*|reopen|keystroke|keyCode|keyDown|keyUp|click|performAction)\s*\(|frontmost\s*=/;

export function scriptTakesFocus(script: string, jxa: boolean): string | null {
  const code = stripStrings(script)
    .split("\n")
    .map((line) => line.replace(jxa ? /\/\/.*$/ : /--.*$|#.*$/, ""))
    .join("\n");
  const match = (jxa ? JXA_FOCUS : APPLESCRIPT_FOCUS).exec(code);
  return match ? match[0].trim() : null;
}

type Options = { readScript?: (path: string) => string | null };

export function guardBashCommand(command: string, options: Options = {}): FocusGuardResult {
  const inserts: { at: number; opened: string }[] = [];
  const segments = splitSegments(command);
  for (const segment of segments) {
    const at = commandIndex(segment.tokens);
    if (at < 0) continue;
    const head = segment.tokens[at];
    const name = baseName(head.value);
    const rest = segment.tokens.slice(at + 1);
    if (name === "open") {
      if (!openHasBackground(rest)) inserts.push({ at: head.end, opened: command.slice(head.start, segment.end).trim() });
      continue;
    }
    if (name === "cliclick") return { action: "deny", reason: FOCUS_DENY_REASON, matched: "cliclick" };
    if (name === "osascript") {
      const jxa = rest.some((t, i) => /^-l\s*JavaScript$/i.test(t.value) || (t.value === "-l" && /^JavaScript$/i.test(rest[i + 1]?.value ?? "")) || /^-lJavaScript$/i.test(t.value));
      const parts: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i].value;
        if (word === "-e" && rest[i + 1]) parts.push(rest[++i].value);
        else if (!word.startsWith("-") && options.readScript) {
          const text = options.readScript(word);
          if (text) parts.push(text);
        }
      }
      if (/<<-?\s*['"]?\w+/.test(command.slice(head.start, segment.end + 1)) || rest.some((t) => t.value.startsWith("<<"))) parts.push(command.slice(segment.end));
      const hit = scriptTakesFocus(unquoteScript(parts.map((p) => ({ value: p, start: 0, end: 0 }))), jxa);
      if (hit) return { action: "deny", reason: FOCUS_DENY_REASON, matched: `osascript ${hit}` };
    }
  }
  if (!inserts.length) return { action: "pass" };
  let fixed = command;
  for (const { at } of [...inserts].sort((a, b) => b.at - a.at)) fixed = `${fixed.slice(0, at)} -g${fixed.slice(at)}`;
  return { action: "rewrite", command: fixed, opens: inserts.map((i) => i.opened) };
}
