// Bash 명령이 사용자의 포커스, 마우스, 키보드를 뺏지 않게 판정한다(순수 함수, 실행하지 않는다).
//  - open: 앱을 여는데 -g(백그라운드)가 없으면 `open` 바로 뒤에 -g 를 끼워 넣는다.
//  - osascript: 앱을 앞으로 가져오거나(activate) System Events 로 키와 클릭을 보내면 막는다.
//  - cliclick: 마우스를 움직이므로 막는다.
// 따옴표 안의 글자(echo "open -a Foo")는 명령이 아니므로 건드리지 않는다. $( ) 와 백틱 안은 따옴표 밖일 때만 본다.
export type FocusGuardResult = { action: "pass" } | { action: "rewrite"; command: string; opens: string[] } | { action: "deny"; reason: string; matched: string };

export const FOCUS_DENY_REASON = "사용자의 포커스와 입력을 뺏는 명령이라 막았다. 창을 앞으로 가져오지 말고 CDP/API 로 조작하라";

type Token = { value: string; start: number; end: number };
type Segment = { tokens: Token[]; end: number };

// 단순 명령 경계(; & | 줄바꿈 ( ) 백틱 $( ))로 나누고 따옴표를 푼 낱말을 만든다. 낱말은 원문 위치를 갖는다.
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
  let i = 0;
  while (i < command.length) {
    const c = command[i];
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
      // 2>&1, >&2, &>file 의 &는 리다이렉션이다
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
      // 낱말 첫 글자의 #는 주석이다
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

const RESERVED = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "time", "nohup", "command", "exec", "builtin", "sudo", "nice", "caffeinate"]);
const XARGS_WITH_VALUE = new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-J", "-R", "-S"]);
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

// 명령 낱말의 위치. 예약어, 환경변수 대입, env, xargs 같은 앞머리를 건너뛴다. 없으면 -1.
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

// open 호출에 -g(--background)가 있는지. 짧은 옵션 묶음(-ga, -nga)도 본다. --args 뒤는 앱에 넘기는 인자라 보지 않는다.
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

// AppleScript 와 JXA 에서 문자열 리터럴을 비운다("display notification "activate"" 가 걸리지 않게).
const stripStrings = (script: string) => script.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");

const APPLESCRIPT_FOCUS = /\b(activate|reopen|frontmost|keystroke|key\s+code|key\s+down|key\s+up|click|perform\s+action|AXRaise|AXPress)\b/i;
const JXA_FOCUS = /\.(activate\w*|reopen|keystroke|keyCode|keyDown|keyUp|click|performAction)\s*\(|frontmost\s*=/;

// 스크립트가 포커스나 입력을 뺏는지. 주석(-- 와 //)은 빼고 본다.
export function scriptTakesFocus(script: string, jxa: boolean): string | null {
  const code = stripStrings(script)
    .split("\n")
    .map((line) => line.replace(jxa ? /\/\/.*$/ : /--.*$|#.*$/, ""))
    .join("\n");
  const match = (jxa ? JXA_FOCUS : APPLESCRIPT_FOCUS).exec(code);
  return match ? match[0].trim() : null;
}

type Options = { readScript?: (path: string) => string | null };

// 입력 명령을 판정한다. 막을 것이 하나라도 있으면 deny, 고칠 것만 있으면 rewrite, 아니면 pass.
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
      // here-document 본문은 다음 줄들에 있다
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
