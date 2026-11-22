import { targetWindow } from "./windows";

export type PathKind = "dir" | "file" | "other" | "missing";
export type PathFs = { kind: (path: string) => PathKind; real: (path: string) => string };

export type OpenTarget =
  | { kind: "folder"; dir: string }
  | { kind: "file"; dir: string; file: string; position?: OpenPosition }
  | { kind: "missing"; path: string }
  | { kind: "unsupported"; path: string };

export type OpenPosition = { line: number; column?: number };

export function splitOpenPosition(raw: string): { path: string; position: OpenPosition | null } {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(raw);
  if (!match) return { path: raw, position: null };
  const line = Number(match[2]);
  if (line < 1) return { path: raw, position: null };
  const column = match[3] ? Number(match[3]) : 0;
  return { path: match[1], position: column >= 1 ? { line, column } : { line } };
}

export const baseNameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function dirNameOf(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

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

export function classifyOpenPath(raw: string, base: { home: string; cwd: string }, fs: PathFs): OpenTarget {
  const absolute = absoluteOpenPath(raw, base);
  if (!absolute) return { kind: "missing", path: raw };
  const kind = fs.kind(absolute);
  if (kind === "missing") return positionedFile(absolute, fs) ?? { kind: "missing", path: absolute };
  if (kind === "other") return { kind: "unsupported", path: absolute };
  const real = fs.real(absolute);
  if (kind === "dir") return { kind: "folder", dir: real };
  return { kind: "file", dir: dirNameOf(real), file: baseNameOf(real) };
}

export function containingDir(dir: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  for (const candidate of candidates) {
    if ((dir === candidate || dir.startsWith(`${candidate}/`)) && (best === null || candidate.length > best.length)) best = candidate;
  }
  return best;
}

export function fileUnder(owner: string, dir: string, file: string) {
  return `${dir}/${file}`.slice(owner.length + 1);
}

function positionedFile(absolute: string, fs: PathFs): OpenTarget | null {
  const { path, position } = splitOpenPosition(absolute);
  if (!position || fs.kind(path) !== "file") return null;
  const real = fs.real(path);
  return { kind: "file", dir: dirNameOf(real), file: baseNameOf(real), position };
}

export function argvOpenPaths(argv: readonly string[], options: { defaultApp: boolean; cwd: string; home: string }): string[] {
  const out: string[] = [];
  const rest = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  for (const arg of options.defaultApp ? rest.slice(1) : rest) {
    const absolute = absoluteOpenPath(arg, options);
    if (absolute && !out.includes(absolute)) out.push(absolute);
  }
  return out;
}

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

export function planOpenWindow(input: { windows: readonly { id: string; dirs: ReadonlySet<string>; layout?: string | null }[]; dir: string; focusedId: string | null; lastActiveId: string | null; spareId: string | null; reuseLayout?: string }): OpenWindowPlan {
  const showing = input.windows.filter((w) => w.dirs.has(input.dir) && (input.reuseLayout === undefined || w.layout === input.reuseLayout)).map((w) => w.id);
  if (showing.length > 0) {
    const id = targetWindow({ ids: showing, focusedId: input.focusedId, lastActiveId: input.lastActiveId });
    if (id) return { kind: "existing", windowId: id };
  }
  if (input.spareId) return { kind: "spare", windowId: input.spareId };
  return { kind: "new" };
}

export function worktreeParentDir(real: string, tree: { root: string; mainRoot: string }) {
  const rest = real === tree.root ? "" : real.startsWith(`${tree.root}/`) ? real.slice(tree.root.length + 1) : "";
  return rest ? `${tree.mainRoot}/${rest}` : tree.mainRoot;
}

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

  ready(): Promise<void> {
    this.started = true;
    for (const entry of this.waiting.splice(0)) this.run(entry);
    return this.chain.then(() => undefined);
  }

  private run(entry: { request: Request; resolve: (value: Result) => void; reject: (error: unknown) => void }) {
    this.chain = this.chain.then(() => this.handle(entry.request)).then(entry.resolve, entry.reject);
  }
}
