import { runInNewContext } from "node:vm";
import type { Agent, Workspace } from "../shared/protocol";
import { applyHostColors, EMBED_COLORS, isCssColor, isHostOrigin, type EmbedColors } from "../shared/embed";
import { bindFrame, DEFAULT_OPEN_IN, dropFrame, dropMissing, frameTitle, MAX_FRAMES, normalizeOpenIn, pickAttachTarget, showFrame, type Frame } from "../vscode-extension/src/chatState";
import { chatHtml, embedUrl, panelHtml } from "../vscode-extension/src/html";
import { attentionCount, describeSession, matchSessions, relativeTime, selectedLines, sortSessions, statusOf, workspaceForFolder } from "../vscode-extension/src/match";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const NOW = Date.parse("2026-10-15T12:00:00Z");
const ws = (id: string, dir: string, parentId: string | null = null, feedback = false): Workspace => ({ id, name: id, dir, parentId, ...(feedback ? { feedback: true } : {}) });
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  workspaceId: "main",
  cwd: "/p/app",
  worktree: null,
  forkedFrom: null,
  resumeFrom: null,
  startCommit: null,
  feedbackId: null,
  title: id,
  sessionId: null,
  status: "idle",
  permissionMode: "default",
  model: null,
  effort: null,
  activeModel: null,
  activeEffort: null,
  backgroundTasks: 0,
  createdAt: "2026-10-15T11:00:00Z",
  updatedAt: "2026-10-15T11:00:00Z",
  ...over,
});
// /tmp 가 /private/tmp 로 풀리는 것처럼 심볼릭 링크를 흉내 낸다.
const real = (path: string) => path.replace(/^\/link\//, "/p/");

const workspaces = [ws("main", "/p/app"), ws("wt", "/p/app.worktrees/feat", "main"), ws("other", "/p/other"), ws("fb", "/p/app", null, true)];

test("프로젝트 폴더를 열면 그 프로젝트와 worktree 세션이 나온다", () => {
  const agents = [
    agent("a"),
    agent("b", { workspaceId: "wt", cwd: "/p/app.worktrees/feat", worktree: { root: "/p/app.worktrees/feat", branch: "feat", base: "main" } as Agent["worktree"] }),
    agent("c", { workspaceId: "other", cwd: "/p/other" }),
  ];
  const got = matchSessions(["/p/app"], workspaces, agents, real).map((a) => a.id);
  return expect(got.join() === "a,b", `a, b 만 나와야 한다: ${got.join()}`);
});

test("worktree 폴더를 열면 그 worktree 세션만 나온다", () => {
  const agents = [agent("a"), agent("b", { workspaceId: "wt", cwd: "/p/app.worktrees/feat" })];
  const got = matchSessions(["/p/app.worktrees/feat"], workspaces, agents, real).map((a) => a.id);
  return expect(got.join() === "b", `b 만: ${got.join()}`);
});

test("경로는 realpath 로 비교한다 (심볼릭 링크로 연 폴더)", () => {
  const got = matchSessions([real("/link/app")], workspaces, [agent("a")], real).map((a) => a.id);
  const folder = workspaceForFolder(real("/link/app"), workspaces, real);
  return expect(got.join() === "a" && folder?.id === "main", `got=${got.join()} folder=${folder?.id}`);
});

test("상위, 하위 폴더와 폴더 없는 세션, 피드백 세션은 제외한다", () => {
  const agents = [agent("chat", { workspaceId: null, cwd: "/p/app" }), agent("fb", { workspaceId: "fb", feedbackId: "f1" }), agent("sub", { workspaceId: "other", cwd: "/p/app/sub" })];
  const got = matchSessions(["/p/app"], workspaces, agents, real).map((a) => a.id);
  const parent = matchSessions(["/p"], workspaces, [agent("a")], real);
  return expect(got.length === 0 && parent.length === 0, `got=${got.join()} parent=${parent.length}`);
});

test("폴더에 맞는 워크스페이스가 없으면 null, 프로젝트가 worktree 보다 먼저", () => {
  const dup = [ws("child", "/p/x", "main"), ws("top", "/p/x")];
  return expect(workspaceForFolder("/p/none", workspaces, real) === null && workspaceForFolder("/p/x", dup, real)?.id === "top", "null 과 top");
});

test("상태: 진행 중, 승인 대기, 오류, 안 읽음, 읽음", () => {
  const states = [agent("r", { status: "running" }), agent("w", { status: "waiting" }), agent("e", { status: "error" }), agent("u", { unread: true }), agent("n")].map(statusOf);
  return expect(states.join() === "running,waiting,error,unread,read", states.join());
});

test("트리 설명: 상태 문구와 상대 시간", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const d = [
    describeSession(agent("r", { status: "running", updatedAt: at(2 * 60_000) }), NOW),
    describeSession(agent("w", { status: "waiting", updatedAt: at(30_000) }), NOW),
    describeSession(agent("u", { unread: true, updatedAt: at(3 * 3600_000) }), NOW),
    describeSession(agent("n", { updatedAt: at(2 * 86400_000) }), NOW),
  ];
  return expect(d.join("|") === "Working... 2m|Input needed now|3h|2d", d.join("|"));
});

test("상대 시간 단위: now, 분, 시간, 일, 주", () => {
  const u = [0, 59_000, 60_000, 3599_000, 3600_000, 86399_000, 86400_000, 7 * 86400_000, 15 * 86400_000].map(relativeTime);
  return expect(u.join() === "now,now,1m,59m,1h,23h,1d,1w,2w", u.join());
});

test("정렬은 고정 먼저, 그다음 최근 순. 배지는 승인 대기와 안 읽음(완료 제외)", () => {
  const list = [agent("old", { updatedAt: "2026-10-15T09:00:00Z" }), agent("new", { updatedAt: "2026-10-15T11:30:00Z" }), agent("pin", { pinned: true, updatedAt: "2026-10-14T00:00:00Z" })];
  const order = sortSessions(list).map((a) => a.id).join();
  const count = attentionCount([agent("w", { status: "waiting" }), agent("u", { unread: true }), agent("d", { unread: true, done: true }), agent("n")]);
  return expect(order === "pin,new,old" && count === 2, `order=${order} count=${count}`);
});

test("선택 영역은 걸친 줄 전체이고, 끝이 다음 줄 맨 앞이면 그 줄은 뺀다", () => {
  const lines = ["aaa", "bbb", "ccc", "ddd"];
  const at = (line: number) => lines[line];
  const partial = selectedLines(at, { line: 0, character: 1 }, { line: 1, character: 2 });
  const toNextLine = selectedLines(at, { line: 1, character: 0 }, { line: 3, character: 0 });
  const single = selectedLines(at, { line: 2, character: 0 }, { line: 2, character: 3 });
  return expect(
    partial.startLine === 1 && partial.endLine === 2 && partial.text === "aaa\nbbb" && toNextLine.startLine === 2 && toNextLine.endLine === 3 && toNextLine.text === "bbb\nccc" && single.text === "ccc" && single.endLine === 3,
    JSON.stringify({ partial, toNextLine, single }),
  );
});

test("webview 문서: CSP 는 데몬 출처의 frame 만 허용하고 스크립트는 nonce 뿐", () => {
  const html = panelHtml({ nonce: "N0NCE", origin: "http://127.0.0.1:7788", src: embedUrl(7788, { agentId: "a&b" }, "dark"), theme: "dark" });
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  return expect(
    csp.includes("default-src 'none'") && csp.includes("frame-src http://127.0.0.1:7788;") && csp.includes("script-src 'nonce-N0NCE'") && !csp.includes("unsafe-inline") && !/<script(?![^>]*nonce="N0NCE")/.test(html) && html.includes("embed=session") && html.includes("agent=a%26b"),
    csp,
  );
});

test("호스트 출처: VS Code webview 만 인정", () => {
  const ok = isHostOrigin("vscode-webview://abc") && isHostOrigin("https://x.vscode-cdn.net");
  const bad = isHostOrigin("http://127.0.0.1:7788") || isHostOrigin("https://evil.example") || isHostOrigin("null") || isHostOrigin("https://vscode-cdn.net.evil.example");
  return expect(ok && !bad, `ok=${ok} bad=${bad}`);
});


const THEME_VARS: Record<string, Record<string, string>> = {
  dark: { "--vscode-editor-background": "#1f1f1f", "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d", "--vscode-input-background": "#313131", "--vscode-input-border": "#3c3c3c", "--vscode-focusBorder": "#0078d4", "--vscode-button-background": "#0078d4", "--vscode-button-foreground": "#ffffff", "--vscode-textLink-foreground": "#4daafc", "--vscode-editorWidget-background": "#202020", "--vscode-list-hoverBackground": "#2a2d2e", "--vscode-list-inactiveSelectionBackground": "#37373d" },
  light: { "--vscode-editor-background": "#ffffff", "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#717171", "--vscode-input-background": "#ffffff", "--vscode-input-border": "#cecece", "--vscode-focusBorder": "#005fb8", "--vscode-button-background": "#005fb8", "--vscode-button-foreground": "#ffffff", "--vscode-textLink-foreground": "#005fb8", "--vscode-editorWidget-background": "#f8f8f8", "--vscode-list-hoverBackground": "#f2f2f2", "--vscode-list-inactiveSelectionBackground": "#e4e6f1" },
  // 고대비는 일부 변수가 비어 있다(값 없음은 기본 토큰을 쓴다)
  hc: { "--vscode-editor-background": "#000000", "--vscode-foreground": "#ffffff", "--vscode-focusBorder": "#f38518", "--vscode-button-background": "#000000", "--vscode-button-foreground": "#ffffff", "--vscode-textLink-foreground": "#21a6ff" },
};

function runPanelScript(initial: string) {
  const html = panelHtml({ nonce: "N0NCE", origin: "http://127.0.0.1:7788", src: "http://127.0.0.1:7788/?embed=session", theme: "dark" });
  const script = /<script nonce="N0NCE">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  let vars = THEME_VARS[initial];
  const toFrame: { type: string; colors?: EmbedColors; theme?: string }[] = [];
  const observers: (() => void)[] = [];
  let onMessage: (event: unknown) => void = () => undefined;
  const frame = { src: "", contentWindow: { postMessage: (message: (typeof toFrame)[number]) => toFrame.push(message) } };
  const element = () => ({ hidden: false, textContent: "", addEventListener: () => undefined });
  const elements: Record<string, unknown> = { app: frame, offline: element(), "offline-text": element(), "open-app": element() };
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: () => undefined, setState: () => undefined }),
    document: { getElementById: (id: string) => elements[id], documentElement: {}, body: {} },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => vars[name] ?? "" }),
    MutationObserver: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
    },
    window: { addEventListener: (_type: string, handler: (event: unknown) => void) => (onMessage = handler) },
  });
  return {
    ready: () => onMessage({ data: { type: "agent-nav:ready" }, source: frame.contentWindow, origin: "http://127.0.0.1:7788" }),
    switchTheme: (name: string) => {
      vars = THEME_VARS[name];
      for (const callback of observers) callback();
    },
    toFrame,
  };
}

const lastColors = (messages: { type: string; colors?: EmbedColors }[]) => messages.filter((m) => m.type === "agent-nav:colors").at(-1)?.colors;
// 웹이 토큰에 덮은 값을 읽는다.
function tokensFor(colors: EmbedColors | undefined) {
  const set = new Map<string, string>();
  applyHostColors({ style: { setProperty: (name, value) => void set.set(name, value), removeProperty: (name) => (set.delete(name), "") } }, colors ?? {});
  return set;
}

test("webview 는 ready 를 받으면 hello 다음에 VS Code 색을 보낸다", () => {
  const panel = runPanelScript("dark");
  panel.ready();
  const types = panel.toFrame.map((m) => m.type).join();
  const colors = lastColors(panel.toFrame);
  return expect(types === "agent-nav:hello,agent-nav:colors" && colors?.editorBackground === "#1f1f1f" && colors.foreground === "#cccccc" && Object.keys(colors).length === Object.keys(EMBED_COLORS).length - 1, `${types} ${JSON.stringify(colors)}`);
});

test("테마를 바꾸면 다크, 라이트, 고대비 값이 따로 나가고, 같은 값은 다시 보내지 않는다", () => {
  const panel = runPanelScript("dark");
  panel.ready();
  panel.switchTheme("light");
  const light = lastColors(panel.toFrame);
  const countAfterLight = panel.toFrame.length;
  panel.switchTheme("light");
  const unchanged = panel.toFrame.length === countAfterLight;
  panel.switchTheme("hc");
  const hc = lastColors(panel.toFrame);
  return expect(light?.editorBackground === "#ffffff" && light.foreground === "#3b3b3b" && light.buttonBackground === "#005fb8" && unchanged && hc?.editorBackground === "#000000" && hc.inputBackground === undefined, JSON.stringify({ light, hc, unchanged }));
});

test("웹은 받은 색을 토큰에 덮고, 이번에 오지 않은 역할은 지운다", () => {
  const dark = tokensFor(THEME_VARS_COLORS("dark"));
  const light = tokensFor(THEME_VARS_COLORS("light"));
  const hc = tokensFor(THEME_VARS_COLORS("hc"));
  return expect(
    dark.get("--pane-bg") === "#1f1f1f" && dark.get("--input-bg") === "#313131" && dark.get("--accent") === "#0078d4" && light.get("--pane-bg") === "#ffffff" && light.get("--fg") === "#3b3b3b" && hc.get("--pane-bg") === "#000000" && !hc.has("--accent") && hc.get("--accent-fg") === "#ffffff" && !hc.has("--input-bg") && !hc.has("--surface-overlay"),
    JSON.stringify({ dark: [...dark], hc: [...hc] }),
  );
});

test("색 값은 CSS 색 모양만 받는다", () => {
  const good = ["#1f1f1f", "#fff", "rgba(38, 79, 120, 0.3)", "rgb(0 0 0 / 50%)"].every(isCssColor);
  const bad = ["url(http://x)", "red; background: url(x)", "var(--x)", "", 12, null, "#1f1f1f}</style>", "x".repeat(200)].some(isCssColor);
  return expect(good && !bad, `good=${good} bad=${bad}`);
});

// 흉내 낸 테마 변수 표를 역할 이름으로 바꾼다(webview 스크립트가 하는 일과 같다).
function THEME_VARS_COLORS(name: string): EmbedColors {
  return Object.fromEntries(Object.entries(EMBED_COLORS).flatMap(([role, { vscode }]) => (THEME_VARS[name][vscode] ? [[role, THEME_VARS[name][vscode]]] : [])));
}

// --- 사이드바 Chat 뷰: 화면 목록(chatState)과 webview 문서(chatHtml) ---

const frame = (id: string, over: Partial<Frame> = {}): Frame => ({ key: `agent:${id}`, agentId: id, workspaceId: null, src: `src-${id}`, ...over });
const draft = (workspaceId: string): Frame => ({ key: `draft:${workspaceId}`, agentId: null, workspaceId, src: `draft-${workspaceId}` });
const keys = (frames: Frame[]) => frames.map((f) => f.key).join();

test("화면을 열면 맨 뒤로 올라가고, 이미 있던 화면은 key 와 src 를 그대로 둔다", () => {
  const a = frame("a");
  const first = showFrame([a, frame("b")], { ...a, key: "other", src: "NEW" });
  return expect(keys(first.frames) === "agent:b,agent:a" && first.frames.at(-1)?.src === "src-a" && first.dropped.length === 0, JSON.stringify(first.frames.map((f) => f.src)));
});

test("입력창에서 생긴 세션 화면을 그 세션으로 다시 열면 새 화면을 만들지 않고, 같은 폴더의 새 입력창은 따로 만든다", () => {
  const bound = bindFrame([draft("w1")], "draft:w1", "n", "src-n").frames;
  const again = showFrame(bound, { key: "k2", agentId: "n", workspaceId: null, src: "src-n" });
  const fresh = showFrame(bound, { key: "k3", agentId: null, workspaceId: "w1", src: "d" });
  const reuse = showFrame([draft("w1"), frame("a")], { key: "k4", agentId: null, workspaceId: "w1", src: "d" });
  return expect(keys(again.frames) === "draft:w1" && keys(fresh.frames) === "draft:w1,k3" && keys(reuse.frames) === "agent:a,draft:w1", `${keys(again.frames)} ${keys(fresh.frames)} ${keys(reuse.frames)}`);
});

test("화면이 최대 개수를 넘으면 가장 오래 안 본 것부터 버린다", () => {
  let frames: Frame[] = [];
  let dropped: Frame[] = [];
  for (let i = 0; i < MAX_FRAMES + 2; i++) ({ frames, dropped } = showFrame(frames, frame(`s${i}`)));
  const reopen = showFrame(frames, frame("s3"));
  return expect(frames.length === MAX_FRAMES && dropped.map((f) => f.key).join() === "agent:s1" && frames[0].key === "agent:s2" && reopen.frames.at(-1)?.key === "agent:s3" && reopen.dropped.length === 0, `${keys(frames)} dropped=${keys(dropped)}`);
});

test("새 세션 입력창에서 첫 메시지를 보내면 그 화면이 세션 화면이 되고 같은 세션의 다른 화면은 버려진다", () => {
  const frames = [frame("x"), draft("w1"), frame("y")];
  const bound = bindFrame(frames, "draft:w1", "x", "src-x2");
  const plain = bindFrame([frame("x"), draft("w1")], "draft:w1", "n", "src-n");
  const noop = bindFrame(frames, "draft:missing", "x", "src");
  return expect(
    keys(bound.frames) === "draft:w1,agent:y" && bound.frames[0].agentId === "x" && bound.frames[0].src === "src-x2" && bound.frames[0].workspaceId === null && keys(bound.dropped) === "agent:x" && keys(plain.frames) === "agent:x,draft:w1" && plain.frames[1].agentId === "n" && plain.dropped.length === 0 && noop.frames === frames,
    `${keys(bound.frames)} | ${keys(plain.frames)}`,
  );
});

test("보이던 화면이 중복으로 버려지면 새로 묶인 화면이 그 자리를 잇는다", () => {
  const bound = bindFrame([draft("w1"), frame("x")], "draft:w1", "x", "src-x2");
  return expect(keys(bound.frames) === "draft:w1" && bound.frames[0].agentId === "x" && bound.frames[0].src === "src-x2", keys(bound.frames));
});

test("데몬에서 사라진 세션의 화면만 빼고 새 세션 입력창은 남긴다", () => {
  const out = dropMissing([frame("a"), draft("w"), frame("gone")], (id) => id === "a");
  return expect(keys(out.frames) === "agent:a,draft:w" && keys(out.dropped) === "agent:gone" && keys(dropFrame(out.frames, "draft:w")) === "agent:a", keys(out.frames));
});

test("Chat 뷰 이름: 세션은 제목, 새 입력창은 New Session, 없으면 비움", () => {
  const titles: Record<string, string> = { a: "Fix login" };
  const of = (id: string) => titles[id];
  return expect(frameTitle(frame("a"), of) === "Fix login" && frameTitle(frame("zz"), of) === "Lodestar" && frameTitle(draft("w"), of) === "New Session" && frameTitle(null, of) === undefined, "titles");
});

test("lodestar.openSessionIn: 모르는 값은 기본값(sidebar)", () => {
  return expect(normalizeOpenIn("editor") === "editor" && normalizeOpenIn("sidebar") === "sidebar" && normalizeOpenIn(undefined) === DEFAULT_OPEN_IN && normalizeOpenIn("tab") === "sidebar" && DEFAULT_OPEN_IN === "sidebar", "values");
});

test("선택 영역 첨부 대상: 포커스 있는 패널 > 설정이 정한 쪽 > 다른 쪽 > 없음", () => {
  const pick = (over: Partial<Parameters<typeof pickAttachTarget>[0]>) => pickAttachTarget({ openIn: "sidebar", panelFocused: false, panelsOpen: false, sidebarHasSession: false, ...over });
  return expect(
    pick({ panelFocused: true, panelsOpen: true, sidebarHasSession: true }) === "panel" &&
      pick({ panelsOpen: true, sidebarHasSession: true }) === "sidebar" &&
      pick({ panelsOpen: true }) === "panel" &&
      pick({ openIn: "editor", panelsOpen: true, sidebarHasSession: true }) === "panel" &&
      pick({ openIn: "editor", sidebarHasSession: true }) === "sidebar" &&
      pick({}) === null,
    "order",
  );
});

type FakeFrame = { src: string; hidden: boolean; removed: boolean; focused: boolean; sets: number; sent: { type: string; theme?: string }[]; contentWindow: { postMessage: (m: { type: string; theme?: string }) => void }; remove: () => void; focus: () => void };

// chatHtml 의 스크립트를 가짜 문서에서 돌린다. 확장 -> 문서 메시지는 host(), iframe -> 문서 메시지는 fromFrame(), 문서 -> 확장은 posted 에 쌓인다.
function runChatScript() {
  const html = chatHtml({ nonce: "N0NCE", origin: "http://127.0.0.1:7788", theme: "dark" });
  const script = /<script nonce="N0NCE">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const iframes: FakeFrame[] = [];
  const posted: { kind: string; frame?: string; message?: { type: string; agentId?: string } }[] = [];
  const el = () => ({ hidden: false, textContent: "", addEventListener: () => undefined });
  const elements: Record<string, { hidden: boolean; textContent: string }> = { empty: el(), offline: el(), "offline-text": el(), "open-app": el(), "new-session": el() };
  let onMessage: (event: unknown) => void = () => undefined;
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (m: (typeof posted)[number]) => posted.push(m) }),
    document: {
      getElementById: (id: string) => elements[id],
      createElement: () => {
        let src = "";
        const f: FakeFrame = {
          get src() {
            return src;
          },
          set src(value: string) {
            src = value;
            f.sets++;
          },
          hidden: false,
          removed: false,
          focused: false,
          sets: 0,
          sent: [],
          contentWindow: { postMessage: (m) => f.sent.push(m) },
          remove: () => void (f.removed = true),
          focus: () => void (f.focused = true),
        };
        iframes.push(f);
        return f;
      },
      documentElement: {},
      body: { appendChild: () => undefined },
    },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => THEME_VARS.dark[name] ?? "" }),
    MutationObserver: class {
      observe() {}
    },
    window: { addEventListener: (_type: string, handler: (event: unknown) => void) => (onMessage = handler) },
  });
  const origin = "http://127.0.0.1:7788";
  return {
    host: (data: object) => onMessage({ data, source: null, origin: "vscode-webview://x" }),
    fromFrame: (index: number, data: object, from = origin) => onMessage({ data, source: iframes[index].contentWindow, origin: from }),
    iframes,
    posted,
    elements,
    html,
  };
}

const list = (...fs: Frame[]) => fs.map(({ key, src }) => ({ key, src }));

test("Chat 문서: CSP 는 데몬 출처 frame 과 nonce 스크립트만 허용하고 문서를 시작하면 ready 를 보낸다", () => {
  const chat = runChatScript();
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(chat.html)?.[1] ?? "";
  return expect(csp.includes("default-src 'none'") && csp.includes("frame-src http://127.0.0.1:7788;") && csp.includes("script-src 'nonce-N0NCE'") && !csp.includes("unsafe-inline") && chat.posted[0]?.kind === "ready" && chat.html.includes("--vscode-sideBar-background"), csp);
});

test("Chat 문서: 세션마다 iframe 을 하나 만들고 보이는 것 하나만 둔다. 다시 전환해도 iframe 은 다시 불리지 않는다", () => {
  const chat = runChatScript();
  const [a, b] = [frame("a"), frame("b")];
  chat.host({ kind: "frames", frames: list(a), active: a.key });
  chat.host({ kind: "frames", frames: list(a, b), active: b.key });
  const afterB = chat.iframes.map((f) => `${f.src}:${f.hidden}`).join();
  chat.host({ kind: "frames", frames: list(b, a), active: a.key });
  chat.host({ kind: "frames", frames: list(b, { ...a, src: "CHANGED" }), active: a.key });
  return expect(chat.iframes.length === 2 && afterB === "src-a:true,src-b:false" && chat.iframes.map((f) => f.hidden).join() === "false,true" && chat.iframes.every((f) => f.sets === 1) && chat.elements.empty.hidden, `${afterB} sets=${chat.iframes.map((f) => f.sets)}`);
});

test("Chat 문서: 목록에서 빠진 화면은 iframe 을 지우고 화면이 하나도 없으면 안내를 보인다", () => {
  const chat = runChatScript();
  const [a, b] = [frame("a"), frame("b")];
  chat.host({ kind: "frames", frames: list(a, b), active: b.key });
  chat.host({ kind: "frames", frames: list(a), active: a.key });
  const removedB = chat.iframes[1].removed && !chat.iframes[0].removed;
  const emptyWhileShown = chat.elements.empty.hidden;
  chat.host({ kind: "frames", frames: [], active: null });
  return expect(removedB && emptyWhileShown && !chat.elements.empty.hidden, `removedB=${removedB} empty=${chat.elements.empty.hidden}`);
});

test("Chat 문서: iframe 의 ready 에는 hello 와 색, 보낸 메시지는 어느 화면 것인지 붙여 확장으로", () => {
  const chat = runChatScript();
  const [a, b] = [frame("a"), frame("b")];
  chat.host({ kind: "frames", frames: list(a, b), active: b.key });
  chat.fromFrame(0, { type: "agent-nav:ready" });
  chat.fromFrame(0, { type: "agent-nav:openFile", file: "/x.ts" });
  chat.fromFrame(1, { type: "agent-nav:session", agentId: "b" });
  chat.fromFrame(1, { type: "not-ours" });
  chat.fromFrame(1, { type: "agent-nav:openFile", file: "/y.ts" }, "https://evil.example");
  const embeds = chat.posted.filter((m) => m.kind === "embed").map((m) => `${m.frame}:${m.message?.type}`).join();
  return expect(chat.iframes[0].sent.map((m) => m.type).join() === "agent-nav:hello,agent-nav:colors" && chat.iframes[1].sent.length === 0 && embeds === "agent:a:agent-nav:ready,agent:a:agent-nav:openFile,agent:b:agent-nav:session", embeds);
});

test("Chat 문서: relay 는 frame 키가 있으면 그 화면에만, 없으면 모두에게. 준비 안 된 화면의 메시지는 ready 뒤에 간다", () => {
  const chat = runChatScript();
  const [a, b] = [frame("a"), frame("b")];
  chat.host({ kind: "frames", frames: list(a, b), active: b.key });
  chat.fromFrame(0, { type: "agent-nav:ready" });
  chat.host({ kind: "relay", frame: b.key, message: { type: "agent-nav:attach" } });
  chat.host({ kind: "relay", frame: b.key, message: { type: "agent-nav:focus" } });
  chat.host({ kind: "relay", message: { type: "agent-nav:theme", theme: "light" } });
  const beforeReady = `${chat.iframes[0].sent.map((m) => m.type).join()}|${chat.iframes[1].sent.length}|${chat.iframes[1].focused}`;
  chat.fromFrame(1, { type: "agent-nav:ready" });
  const hello = chat.iframes[1].sent[0];
  return expect(beforeReady === "agent-nav:hello,agent-nav:colors,agent-nav:theme|0|true" && chat.iframes[1].sent.map((m) => m.type).join() === "agent-nav:hello,agent-nav:colors,agent-nav:attach,agent-nav:focus" && hello.theme === "light", beforeReady);
});

test("Chat 문서: 데몬이 돌아오면 보이는 화면은 바로, 숨은 화면은 보일 때 다시 불러온다", () => {
  const chat = runChatScript();
  const [a, b] = [frame("a"), frame("b")];
  chat.host({ kind: "frames", frames: list(a, b), active: b.key });
  chat.host({ kind: "daemon", online: false, message: "Lodestar is not running on port 7788." });
  const overlayShown = !chat.elements.offline.hidden && chat.elements["offline-text"].textContent.includes("not running");
  chat.host({ kind: "daemon", online: true, message: "" });
  const afterOnline = chat.iframes.map((f) => f.sets).join();
  chat.host({ kind: "frames", frames: list(b, a), active: a.key });
  const afterShow = chat.iframes.map((f) => f.sets).join();
  chat.host({ kind: "frames", frames: list(a, b), active: b.key });
  return expect(overlayShown && chat.elements.offline.hidden && afterOnline === "1,2" && afterShow === "2,2" && chat.iframes.map((f) => f.sets).join() === "2,2", `${afterOnline} ${afterShow}`);
});

test("Chat 문서: 새 세션 입력창이 세션으로 바뀐 뒤 목록의 src 가 바뀌어도 iframe 은 그대로, 다시 불러올 때는 새 주소", () => {
  const chat = runChatScript();
  const d = draft("w1");
  chat.host({ kind: "frames", frames: list(d), active: d.key });
  const bound = { key: d.key, agentId: "n", workspaceId: null, src: "src-n" };
  chat.host({ kind: "frames", frames: list(bound), active: bound.key });
  const untouched = chat.iframes[0].sets === 1 && chat.iframes[0].src === "draft-w1";
  chat.host({ kind: "daemon", online: false, message: "x" });
  chat.host({ kind: "daemon", online: true, message: "" });
  return expect(untouched && chat.iframes.length === 1 && chat.iframes[0].src === "src-n" && chat.iframes[0].sets === 2, `src=${chat.iframes[0].src} sets=${chat.iframes[0].sets}`);
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    console.log(`ok   ${name}: ${run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) {
  console.log(`${failed}/${cases.length} failed`);
  process.exit(1);
}
console.log(`${cases.length}/${cases.length} passed`);
