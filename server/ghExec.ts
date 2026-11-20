import { spawn } from "node:child_process";

// gh CLI 를 부르는 유일한 곳. 토큰은 gh 가 알아서 쓰고 이 프로세스는 읽거나 저장하지 않는다.
// 본문 같은 사용자 글은 -f/-F 인자가 아니라 stdin 의 JSON(--input -)으로만 넘겨서 "@파일" 해석과 인자 길이 문제를 피한다.
export class GhError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "failed",
  ) {
    super(message);
  }
}

export function ghBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_NAV_GH || "gh";
}

export function runGh(args: string[], options: { stdin?: string; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBin(), args, { cwd: options.cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => reject(new GhError(error.code === "ENOENT" ? "GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run gh auth login." : error.message, error.code === "ENOENT" ? "missing" : "failed")));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new GhError(Buffer.concat(err).toString("utf8").trim().split("\n")[0] || Buffer.concat(out).toString("utf8").trim().split("\n")[0] || `gh exited with ${code}`, "failed"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}

type GraphqlReply = { data?: Record<string, unknown> | null; errors?: { message: string }[] };

export async function ghGraphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stdout = await runGh(["api", "graphql", "--input", "-"], { stdin: JSON.stringify({ query, variables }) });
  const reply = JSON.parse(stdout) as GraphqlReply;
  if (reply.errors?.length) throw new GhError(reply.errors.map((e) => e.message).join("; "), "failed");
  return reply.data ?? {};
}

// REST. body 가 있으면 JSON 으로 stdin 에 싣는다. 목록 읽기는 --paginate --slurp 로 페이지를 합친 배열을 받는다.
export async function ghRest(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const args = method === "GET" ? ["api", path] : ["api", "-X", method, path];
  if (body !== undefined) args.push("--input", "-");
  const stdout = await runGh(args, { stdin: body === undefined ? undefined : JSON.stringify(body) });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export async function ghRestPages<T>(path: string): Promise<T[]> {
  const stdout = await runGh(["api", "--paginate", "--slurp", path]);
  const pages = JSON.parse(stdout) as T[][];
  return pages.flat();
}
