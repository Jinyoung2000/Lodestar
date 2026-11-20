// 터미널에서 ⌘I 로 여는 명령 질문(Terminal Ask)의 순수 함수. DOM 과 Node 어디서나 돌아서 웹 화면, 데몬, 단위 시험이 같이 쓴다.
// 맥락 수집(마지막 N줄, 비밀값 가리기), 위험 명령 판정, 응답에서 명령 추출, 직전 오류 판정, 프롬프트 조립이 들어 있다.

export const OUTPUT_LINES = 100;
const MAX_LINE_CHARS = 300; // 한 줄이 이보다 길면 잘라서 보낸다(진행 막대나 빌드 로그 한 줄이 맥락을 먹지 않게)
const MAX_OUTPUT_CHARS = 8000;
const MAX_SELECTION_CHARS = 4000;

export const FIX_SUGGESTION = "Fix the last error";

export type TermAskContext = {
  cwd: string;
  shell: string;
  os: string;
  // 비밀값을 가린 마지막 N줄
  output: string;
  // xterm 에서 고른 글(비밀값을 가림). 없으면 null
  selection: string | null;
  // 후속 질문이면 바로 앞 질문과 답
  previous: { question: string; answer: string } | null;
  // FIXY: 작업 폴더의 프로젝트 표지 파일 요약(projectSummary). 데몬이 폴더를 읽어 채운다. 화면은 보내지 않는다.
  project?: string | null;
};

const REDACTED = "[redacted]";

// 앞의 규칙이 먼저 먹는다. 값만 가리고 키 이름은 남겨서 모델이 무슨 설정인지는 알 수 있게 한다.
const SECRET_RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${REDACTED}`],
  // user:password@host
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${REDACTED}@`],
  // --password hunter2, --token=abc
  [/(--(?:password|passwd|token|api-key|apikey|secret|access-key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, `$1${REDACTED}`],
  // API_KEY=..., "secret": "...", token: ...
  // 이름 덩어리의 처음에서만 시작하고 키워드는 앞보기로 찾는다. [A-Za-z0-9_.-]*키워드[A-Za-z0-9_.-]* 를 아무 데서나 시작하면
  // 긴 한 줄(secretsecret... 같은 고른 글, 압축된 번들)에서 세제곱으로 되짚어 화면이 몇 초씩 멈췄다.
  [/((?<![A-Za-z0-9_.-])["']?(?=[A-Za-z0-9_.-]*?(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key|access[_-]?key|authorization))[A-Za-z0-9_.-]*["']?\s*[=:]\s*)(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s"',;]+)/gi, `$1${REDACTED}`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  return out;
}

// 화면 버퍼의 줄에서 맨 아래 빈 줄을 걷고 마지막 max 줄을 비밀값 가린 한 덩어리로 만든다.
// 글자 상한을 넘으면 오래된(위쪽) 줄부터 버린다.
export function recentOutput(lines: readonly string[], max = OUTPUT_LINES): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  const kept = lines.slice(Math.max(0, end - max), end).map((line) => {
    const trimmed = line.replace(/\s+$/, "");
    return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}...` : trimmed;
  });
  let text = redactSecrets(kept.join("\n"));
  if (text.length > MAX_OUTPUT_CHARS) {
    const cut = text.slice(text.length - MAX_OUTPUT_CHARS);
    text = cut.slice(cut.indexOf("\n") + 1);
  }
  return text;
}

export function selectionContext(selection: string): string | null {
  const text = redactSecrets(selection).trim();
  if (!text) return null;
  return text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}...` : text;
}

// --- 위험 명령 ---

// 한 칸에 하나씩 이유를 돌려준다. 빈 배열이면 위험 패턴이 없다.
// 셸 문법을 다 풀지는 않고, 명령어 위치(줄 처음, ; & | ( 뒤)에서 시작하는 흔한 패턴만 본다.
const CMD = String.raw`(?:^|[;&|(\n]|&&|\|\|)\s*(?:sudo\s+(?:-\S+\s+)*)?`;
const DANGER_RULES: { reason: string; test: (command: string) => boolean }[] = [
  { reason: "Runs with sudo", test: (c) => /(?:^|[;&|(\n])\s*sudo\b/.test(c) },
  { reason: "Deletes recursively (rm -r)", test: (c) => new RegExp(`${CMD}rm\\s+(?:[^;&|\\n]*\\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b`).test(c) },
  { reason: "Deletes files found by find (-delete)", test: (c) => /\bfind\b[^;&|\n]*\s-delete\b/.test(c) },
  { reason: "Force-pushes (git push --force)", test: (c) => /\bgit\s+push\b[^;&|\n]*(?:\s--force\b(?!-with-lease)|\s-f\b|\s\+\S)/.test(c) },
  { reason: "Discards work (git reset --hard)", test: (c) => /\bgit\s+reset\b[^;&|\n]*--hard\b/.test(c) },
  { reason: "Deletes untracked files (git clean)", test: (c) => /\bgit\s+clean\b[^;&|\n]*\s-[a-zA-Z]*f/.test(c) },
  { reason: "Discards changes (git checkout/restore .)", test: (c) => /\bgit\s+(?:checkout\s+(?:--\s+)?|restore\s+(?:--\S+\s+)*)\.(?:\s|$)/.test(c) },
  { reason: "Deletes a branch with -D", test: (c) => /\bgit\s+branch\b[^;&|\n]*\s-D\b/.test(c) },
  { reason: "Writes to a disk device (dd, mkfs)", test: (c) => /\bdd\b[^;&|\n]*\bof=|\bmkfs(?:\.\w+)?\b|\bdiskutil\s+(?:erase|partition|zero)/i.test(c) },
  { reason: "Writes to a device file", test: (c) => />\s*\/dev\/(?:sd|disk|nvme|hd)/.test(c) },
  { reason: "Changes permissions or owner recursively", test: (c) => /\b(?:chmod|chown)\s+(?:[^;&|\n]*\s)?-[a-zA-Z]*R\b/.test(c) },
  { reason: "Pipes a download into a shell", test: (c) => /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(c) },
  { reason: "Kills processes by name or with -9", test: (c) => /\b(?:killall|pkill)\b|\bkill\s+-(?:9|KILL)\b/.test(c) },
  { reason: "Drops or truncates data (SQL)", test: (c) => /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i.test(c) },
  { reason: "Looks like a fork bomb", test: (c) => /:\(\)\s*\{/.test(c) },
];

export function dangerOf(command: string): string[] {
  return DANGER_RULES.filter((rule) => rule.test(command)).map((rule) => rule.reason);
}

export function isMultiline(command: string): boolean {
  return command.trim().includes("\n");
}

// Run 을 누르기 전에 한 번 더 확인해야 하는 이유들. 위험 패턴과 여러 줄. 비어 있으면 바로 실행해도 된다.
export function runConfirmReasons(command: string): string[] {
  const reasons = dangerOf(command);
  if (isMultiline(command)) reasons.push("Has several lines");
  return reasons;
}

// --- 응답에서 명령 추출 ---

export type ExtractedCommand = { command: string; blocks: number; explanation: string };

export function extractCommand(answer: string): ExtractedCommand | null {
  const blocks = [...answer.matchAll(/(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)/g)];
  if (blocks.length === 0) return null;
  const command = cleanCommand(blocks[0][1]);
  if (!command) return null;
  const explanation = answer.replace(/(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { command, blocks: blocks.length, explanation };
}

// 프롬프트 기호($ )가 모든 줄 앞에 붙어 있으면 뗀다. 앞뒤 빈 줄과 줄 끝 공백도 정리한다.
function cleanCommand(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const nonEmpty = lines.filter((line) => line !== "");
  if (nonEmpty.length > 0 && nonEmpty.every((line) => /^\$ /.test(line))) return lines.map((line) => line.replace(/^\$ /, "")).join("\n");
  return lines.join("\n");
}

// --- 직전 오류 ---

const ERROR_LINE = /command not found|no such file or directory|permission denied|not a git repository|\b(?:error|fatal|failed|failure|exception|traceback|panic)\b|npm err!|cannot find|unknown option|invalid option|syntax error|segmentation fault|exit(?:ed with)? (?:code|status) [1-9]/i;

// 화면 맨 아래쪽 몇 줄에 오류처럼 보이는 줄이 있으면 true. 기본 제안(Fix the last error)을 흐리게 보일지 정한다.
export function looksLikeError(lines: readonly string[], within = 12): boolean {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(Math.max(0, end - within), end).some((line) => ERROR_LINE.test(line));
}

// --- 프로젝트 표지 파일 ---

// 작업 폴더 바로 아래에 있으면 어떤 도구 체인인지 알려 주는 파일. 값은 읽을 글(내용에서 이름만 뽑는다)인지 여부다.
export const PROJECT_FILES: Record<string, boolean> = {
  "package.json": true,
  "package-lock.json": false,
  "yarn.lock": false,
  "pnpm-lock.yaml": false,
  "bun.lockb": false,
  "bun.lock": false,
  "deno.json": false,
  "deno.jsonc": false,
  "pyproject.toml": true,
  "requirements.txt": false,
  "setup.py": false,
  "setup.cfg": false,
  "tox.ini": false,
  "pytest.ini": false,
  Pipfile: false,
  "uv.lock": false,
  "poetry.lock": false,
  "Cargo.toml": true,
  "go.mod": false,
  Makefile: true,
  makefile: true,
  GNUmakefile: true,
  justfile: false,
  Justfile: false,
  "Taskfile.yml": false,
  "composer.json": true,
  Gemfile: false,
  "pom.xml": false,
  "build.gradle": false,
  "build.gradle.kts": false,
  "CMakeLists.txt": false,
  "mix.exs": false,
  "Package.swift": false,
  Dockerfile: false,
  "docker-compose.yml": false,
  "compose.yaml": false,
  "tsconfig.json": false,
};

export type ProjectFile = { name: string; text: string | null };

const MAX_NAMES = 16;

function keysOf(text: string | null, field: string): string[] {
  if (!text) return [];
  try {
    const value = (JSON.parse(text) as Record<string, unknown>)[field];
    return value && typeof value === "object" ? Object.keys(value).slice(0, MAX_NAMES) : [];
  } catch {
    return [];
  }
}

function makeTargets(text: string | null): string[] {
  if (!text) return [];
  const names = new Set<string>();
  for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)[ \t]*:(?![=:])/gm)) names.add(match[1]);
  return [...names].slice(0, MAX_NAMES);
}

// 작업 폴더에서 찾은 표지 파일을 모델이 읽을 짧은 목록으로 만든다. 파일 내용은 이름만 뽑고(스크립트 이름, make 대상, 도구 구역 이름) 값은 보내지 않는다.
// 하나도 없으면 없다고 알려서 모델이 도구 체인을 추측하지 않게 한다.
export function projectSummary(files: readonly ProjectFile[]): string {
  const present = new Map(files.map((file) => [file.name, file.text]));
  const has = (...names: string[]) => names.filter((name) => present.has(name));
  const lines: string[] = [];
  if (present.has("package.json")) {
    const scripts = keysOf(present.get("package.json") ?? null, "scripts");
    const manager = has("pnpm-lock.yaml").length ? "pnpm" : has("yarn.lock").length ? "yarn" : has("bun.lockb", "bun.lock").length ? "bun" : has("package-lock.json").length ? "npm" : null;
    const lock = has("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock");
    lines.push(`package.json: scripts ${scripts.length ? scripts.join(", ") : "(none)"}${manager ? `; lockfile ${lock.join(", ")} (${manager})` : "; no lockfile"}`);
  }
  if (present.has("pyproject.toml")) {
    const text = present.get("pyproject.toml") ?? "";
    const tools = [...text.matchAll(/^\[tool\.([A-Za-z0-9_-]+)/gm)].map((m) => m[1]);
    lines.push(`pyproject.toml${tools.length ? `: tool sections ${[...new Set(tools)].slice(0, 8).join(", ")}` : ""}`);
  }
  const python = has("requirements.txt", "setup.py", "setup.cfg", "tox.ini", "pytest.ini", "Pipfile", "uv.lock", "poetry.lock");
  if (python.length) lines.push(python.join(", "));
  if (present.has("Cargo.toml")) lines.push(`Cargo.toml${/^\[workspace\]/m.test(present.get("Cargo.toml") ?? "") ? " (workspace)" : ""}`);
  if (present.has("go.mod")) lines.push("go.mod");
  const make = has("Makefile", "makefile", "GNUmakefile")[0];
  if (make) {
    const targets = makeTargets(present.get(make) ?? null);
    lines.push(`${make}${targets.length ? `: targets ${targets.join(", ")}` : ""}`);
  }
  if (present.has("composer.json")) {
    const scripts = keysOf(present.get("composer.json") ?? null, "scripts");
    lines.push(`composer.json${scripts.length ? `: scripts ${scripts.join(", ")}` : ""}`);
  }
  const rest = has("justfile", "Justfile", "Taskfile.yml", "deno.json", "deno.jsonc", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "CMakeLists.txt", "mix.exs", "Package.swift", "Dockerfile", "docker-compose.yml", "compose.yaml", "tsconfig.json");
  if (rest.length) lines.push(rest.join(", "));
  return redactSecrets(lines.length ? lines.map((line) => `- ${line}`).join("\n") : "(none of the usual project files: package.json, pyproject.toml, Cargo.toml, go.mod, Makefile and so on)");
}

// --- 프롬프트 ---

export const TERM_ASK_SYSTEM_PROMPT = [
  "You turn a request into one shell command for the user's terminal.",
  "The message gives the OS, shell, working directory, the project files found in it, recent terminal output and sometimes the text the user selected. Use them: fix the failing command shown in the output when asked, and use the real file names you can see.",
  "When the project files tell you the toolchain (for example package.json with a test script means npm test, or yarn, pnpm or bun when that lockfile is listed), give that one command. Never write a command that probes for several toolchains with if or elif.",
  "Reply with exactly one fenced code block holding the command, then one or two short sentences saying what it does. Write those sentences in the language of the request.",
  "The command must work in that shell on that OS (on macOS use BSD flags, not GNU ones). Prefer one line. Do not put a prompt symbol ($) in the block.",
  "Prefer read-only or reversible commands. Avoid sudo, rm -rf and force flags unless the request clearly needs them, and say so in the sentences when you use one.",
  "If the request is unclear, give the closest safe command and say what you assumed. Do not use tools. Do not write more than one code block.",
].join("\n");

export function composeTermPrompt(question: string, context: TermAskContext): string {
  const parts = [`OS: ${context.os}`, `Shell: ${context.shell}`, `Working directory: ${context.cwd}`];
  if (context.project) parts.push(`Project files in the working directory:\n${context.project}`);
  if (context.output) parts.push(`Recent terminal output (last lines):\n\`\`\`text\n${context.output}\n\`\`\``);
  if (context.selection) parts.push(`Selected in the terminal:\n\`\`\`text\n${context.selection}\n\`\`\``);
  if (context.previous) parts.push(`Earlier in this conversation:\nUser: ${context.previous.question}\nAssistant: ${context.previous.answer}`);
  parts.push(`Request: ${question}`);
  return parts.join("\n\n");
}
