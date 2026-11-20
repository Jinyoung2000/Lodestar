// 바깥에서 넘어온 경로(open -a, Dock 아이콘에 끌어 놓기, 실행 인자)를 여는 순수 로직.
// Electron, node:fs, DOM 을 import 하지 않아 메인(electron/main.ts), 페이지(web/openFolder.ts), 서버, test/openpath.test.ts 가 같이 쓴다.
// 경로는 macOS(posix) 문자열만 다룬다.
import { targetWindow } from "./windows";

// --- 경로 판정 ---

export type PathKind = "dir" | "file" | "other" | "missing";
// kind 는 심볼릭 링크를 따라간 결과(끊긴 링크는 missing), real 은 심볼릭 링크를 푼 실제 경로다.
export type PathFs = { kind: (path: string) => PathKind; real: (path: string) => string };

export type OpenTarget =
  | { kind: "folder"; dir: string }
  | { kind: "file"; dir: string; file: string }
  | { kind: "missing"; path: string }
  | { kind: "unsupported"; path: string };

export const baseNameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function dirNameOf(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

// "." 와 ".." 와 겹친 "/" 를 정리한다(심볼릭 링크는 건드리지 않는다). 상대 경로는 base 에서 풀어 절대 경로로 만든다.
export function resolvePosix(path: string, base: string) {
  const parts = (path.startsWith("/") ? path : `${base}/${path}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

// 받은 글자를 절대 경로로. 비어 있으면 null. file:// 주소와 ~ 로 시작하는 홈 경로도 푼다.
export function absoluteOpenPath(raw: string, base: { home: string; cwd: string }): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith("file://")) {
    try {
      text = decodeURIComponent(new URL(text).pathname);
    } catch {
      return null;
    }
  }
  if (text === "~" || text.startsWith("~/")) text = `${base.home}${text.slice(1)}`;
  return resolvePosix(text, base.cwd);
}

// 폴더면 그 폴더, 파일이면 그 파일이 든 폴더(심볼릭 링크는 푼 실제 경로 기준)와 파일 이름, 없는 경로나 폴더와 파일이 아닌 것(소켓 등)은 이유를 돌려준다.
export function classifyOpenPath(raw: string, base: { home: string; cwd: string }, fs: PathFs): OpenTarget {
  const absolute = absoluteOpenPath(raw, base);
  if (!absolute) return { kind: "missing", path: raw };
  const kind = fs.kind(absolute);
  if (kind === "missing") return { kind: "missing", path: absolute };
  if (kind === "other") return { kind: "unsupported", path: absolute };
  const real = fs.real(absolute);
  if (kind === "dir") return { kind: "folder", dir: real };
  return { kind: "file", dir: dirNameOf(real), file: baseNameOf(real) };
}

// 실행 인자에서 열 경로만 뽑는다. 실행 파일(과 개발 실행 `electron <앱 경로>` 의 앱 경로)과 `-` 로 시작하는 옵션(Chromium 스위치, macOS 의 -psn_)은 뺀다.
// 상대 경로는 호출한 쪽의 작업 폴더 기준이다(second-instance 는 두 번째 프로세스의 작업 폴더를 준다).
export function argvOpenPaths(argv: readonly string[], options: { defaultApp: boolean; cwd: string; home: string }): string[] {
  const out: string[] = [];
  // 개발 실행(electron <앱 경로>)은 옵션을 뺀 첫 인자가 앱 경로다. second-instance 의 argv 는 Electron 이 옵션을 앞으로 옮겨 앱 경로가 항상 둘째 칸에 있지는 않다.
  const rest = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  for (const arg of options.defaultApp ? rest.slice(1) : rest) {
    const absolute = absoluteOpenPath(arg, options);
    if (absolute && !out.includes(absolute)) out.push(absolute);
  }
  return out;
}

// --- 창 고르기 ---

// 창이 칸에 보여 주는 워크스페이스 폴더. 세션 칸은 그 세션의 폴더, 새 세션 칸은 고른 폴더다(worktree 세션은 부모가 아니라 worktree 폴더 자신).
export type PaneLike = { kind: "agent"; agentId: string } | { kind: "draft"; workspaceId: string | null };
export function workspaceDirsOfPanes(panes: readonly PaneLike[], agents: readonly { id: string; workspaceId: string | null }[], workspaces: readonly { id: string; dir: string }[]): string[] {
  const dirs = new Set<string>();
  for (const pane of panes) {
    const workspaceId = pane.kind === "agent" ? (agents.find((a) => a.id === pane.agentId)?.workspaceId ?? null) : pane.workspaceId;
    const dir = workspaceId ? workspaces.find((w) => w.id === workspaceId)?.dir : undefined;
    if (dir) dirs.add(dir);
  }
  return [...dirs].sort();
}

export type OpenWindowPlan = { kind: "existing"; windowId: string } | { kind: "spare"; windowId: string } | { kind: "new" };

// 그 폴더를 이미 칸에 보여 주는 창이 있으면 그 창(여럿이면 포커스, 마지막 활성 순), 없으면 비어 있는 창(spareId, 방금 열었거나 첫 실행의 빈 창), 그것도 없으면 새 창.
// 폴더 비교는 문자열 그대로다(양쪽 모두 realpath 로 맞춘 경로이고, 부모 폴더와 그 worktree 는 서로 다른 폴더다).
// reuseLayout 을 주면 그 배치(layout)로 폴더를 보여 주는 창만 고른다. 바깥에서 연 폴더는 같은 폴더를 Editor 배치로 보던 창이 있으면 그 창을 앞으로, 없으면 새 창이다(2026-11-04 사용자 요청).
export function planOpenWindow(input: { windows: readonly { id: string; dirs: ReadonlySet<string>; layout?: string | null }[]; dir: string; focusedId: string | null; lastActiveId: string | null; spareId: string | null; reuseLayout?: string }): OpenWindowPlan {
  const showing = input.windows.filter((w) => w.dirs.has(input.dir) && (input.reuseLayout === undefined || w.layout === input.reuseLayout)).map((w) => w.id);
  if (showing.length > 0) {
    const id = targetWindow({ ids: showing, focusedId: input.focusedId, lastActiveId: input.lastActiveId });
    if (id) return { kind: "existing", windowId: id };
  }
  if (input.spareId) return { kind: "spare", windowId: input.spareId };
  return { kind: "new" };
}

// --- worktree 배치 ---

export function worktreeParentDir(real: string, tree: { root: string; mainRoot: string }) {
  const rest = real === tree.root ? "" : real.startsWith(`${tree.root}/`) ? real.slice(tree.root.length + 1) : "";
  return rest ? `${tree.mainRoot}/${rest}` : tree.mainRoot;
}

// --- 데몬이 준비되기 전의 요청 대기열 ---

// ready() 전에 들어온 요청은 쌓아 두었다가 ready() 때 들어온 순서대로 하나씩 처리하고, 그 뒤 요청도 차례로 처리한다(앞 요청이 끝난 뒤에 다음 요청).
// push 가 돌려주는 약속은 그 요청의 처리가 끝나면 결과로 풀리고, 처리 중 던지면 거절된다(다음 요청은 막지 않는다).
export class OpenQueue<Request, Result> {
  private waiting: { request: Request; resolve: (value: Result) => void; reject: (error: unknown) => void }[] = [];
  private started = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly handle: (request: Request) => Promise<Result>) {}

  get isReady() {
    return this.started;
  }

  get pending() {
    return this.waiting.length;
  }

  push(request: Request): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const entry = { request, resolve, reject };
      if (this.started) this.run(entry);
      else this.waiting.push(entry);
    });
  }

  // 쌓인 요청을 처리하기 시작한다. 쌓인 요청이 모두 끝나면 풀리는 약속을 돌려준다.
  ready(): Promise<void> {
    this.started = true;
    for (const entry of this.waiting.splice(0)) this.run(entry);
    return this.chain.then(() => undefined);
  }

  private run(entry: { request: Request; resolve: (value: Result) => void; reject: (error: unknown) => void }) {
    this.chain = this.chain.then(() => this.handle(entry.request)).then(entry.resolve, entry.reject);
  }
}
