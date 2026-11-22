import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { sizeLimit, sniffMedia, extensionOf, verifyMedia } from "./media";

export type MediaGuard = { key: Buffer; origins: ReadonlySet<string> };

export function mediaOriginAllowed(headers: IncomingHttpHeaders, origins: ReadonlySet<string>) {
  const origin = headers.origin;
  if (origin !== undefined) return origins.has(String(origin));
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

export type ByteRange = { start: number; end: number };

export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    return suffix === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size) return "unsatisfiable";
  return end < start ? null : { start, end };
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  "cross-origin-resource-policy": "same-site",
  "referrer-policy": "no-referrer",
  "cache-control": "private, max-age=86400",
} as const;

export async function handleMedia(req: IncomingMessage, res: ServerResponse, url: URL, guard: MediaGuard): Promise<void> {
  const fail = (status: number) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(status === 403 ? "forbidden" : status === 416 ? "range not satisfiable" : "not found");
  };
  if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
  if (!mediaOriginAllowed(req.headers, guard.origins)) return fail(403);
  const path = url.searchParams.get("p") ?? "";
  const mtime = url.searchParams.get("m") ?? "";
  const signature = url.searchParams.get("s") ?? "";
  if (!path || path.length > 1024 || !signature || !verifyMedia(guard.key, path, mtime, signature)) return fail(403);

  if ((await realpath(path).catch(() => null)) !== path) return fail(404);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return fail(404);
  let streamed = false;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) return fail(404);
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const sniffed = sniffMedia(head.subarray(0, bytesRead), extensionOf(path));
    if (!sniffed || info.size > sizeLimit(sniffed.kind)) return fail(404);

    const range = parseRange(typeof req.headers.range === "string" ? req.headers.range : undefined, info.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "content-range": `bytes */${info.size}`, "cache-control": "no-store" }).end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    res.writeHead(range ? 206 : 200, {
      ...SECURITY_HEADERS,
      "content-type": sniffed.mime,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}),
    });
    if (req.method === "HEAD") return void res.end();
    streamed = true;
    const stream = handle.createReadStream({ start, end });
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } finally {
    if (!streamed) await handle.close().catch(() => undefined);
  }
}
