import { spawn } from "node:child_process";

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
