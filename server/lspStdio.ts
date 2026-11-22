import type { ChildProcess } from "node:child_process";

// 언어 서버 stdio 의 Content-Length 프레이밍과 JSON 해석. 브라우저 쪽 Transport 는 헤더 없는 JSON 문자열을 쓴다.

export type Json = Record<string, unknown>;

export function parseJson(text: string): Json | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Json) : null;
  } catch {
    return null;
  }
}

export function writeMessage(child: ChildProcess, text: string) {
  child.stdin?.write(`Content-Length: ${Buffer.byteLength(text, "utf8")}\r\n\r\n${text}`);
}

const MAX_HEADER_BYTES = 64 * 1024;

export function readMessages(child: ChildProcess, onBody: (body: string) => void) {
  let buffer = Buffer.alloc(0);
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buffer.length > MAX_HEADER_BYTES) buffer = Buffer.alloc(0);
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      const bodyStart = headerEnd + 4;
      if (!Number.isFinite(length)) {
        buffer = buffer.subarray(bodyStart);
        continue;
      }
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      onBody(body);
    }
  });
}
