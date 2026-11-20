// INLINEMEDIA: GET /media?p=<실제 경로>&m=<수정 시각>&s=<서명>. 대화 속 이미지와 영상 미리보기의 바이트를 내보낸다(영상 탐색을 위해 Range 를 받는다).
// 서버 공통 코드(server/index.ts)가 Host 를 이미 확인한다. 여기서는 순서대로 Origin(Sec-Fetch-Site), 서명, 경로와 형식을 확인한다.
//  - 서명은 media.resolve(RPC, 토큰으로 인증된 웹소켓)가 허용 규칙(server/media.ts)을 통과시킨 파일에만 붙는다. 서명 없는 주소나 다른 경로로 바꾼 주소는 403.
//  - 서명 뒤에도 매 요청마다 realpath 가 주소의 경로와 같은지(그 뒤에 심볼릭 링크로 바뀌지 않았는지), 일반 파일인지, 형식과 크기 상한을 다시 본다. 실패는 404 하나로 답해 경로 존재 여부를 알려 주지 않는다.
//  - 열 때 O_NOFOLLOW 를 쓰고 같은 파일 핸들로 크기를 보고 읽는다(확인과 읽기 사이에 바뀌는 틈이 없다).
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { sizeLimit, sniffMedia, extensionOf, verifyMedia } from "./media";

export type MediaGuard = { key: Buffer; origins: ReadonlySet<string> };

// <img> 와 <video> 의 같은 출처 GET 에는 Origin 헤더가 없다. 있으면 허용 목록에 있어야 하고, 없으면 브라우저가 알려 주는 Sec-Fetch-Site 가 같은 출처(또는 주소창 직접 입력)여야 한다.
// 두 헤더가 모두 없는 요청(브라우저가 아닌 클라이언트)은 서명이 유일한 증명이다.
export function mediaOriginAllowed(headers: IncomingHttpHeaders, origins: ReadonlySet<string>) {
  const origin = headers.origin;
  if (origin !== undefined) return origins.has(String(origin));
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

export type ByteRange = { start: number; end: number };

// 한 구간만 받는다. 여러 구간(쉼표)이나 모르는 단위, 문법이 틀린 것은 무시하고 전체를 보낸다(null). 시작이 파일 끝을 넘으면 "unsatisfiable"(416).
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
  // 주소창으로 직접 열려도 SVG 안의 스크립트가 돌지 않게 한다(<img> 안에서는 원래 돌지 않는다).
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

  // 서명한 뒤에 경로가 심볼릭 링크로 바뀌었는지: 실제 경로가 주소의 경로와 같아야 한다.
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
    // 스트림이 핸들을 소유한다(autoClose). 받는 쪽이 중간에 끊으면 스트림을 닫아야 핸들이 남지 않는다.
    const stream = handle.createReadStream({ start, end });
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } finally {
    if (!streamed) await handle.close().catch(() => undefined);
  }
}
