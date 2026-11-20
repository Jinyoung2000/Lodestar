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

// 서버 stdout 의 Content-Length 프레임에서 본문을 꺼낸다.
export function readMessages(child: ChildProcess, onBody: (body: string) => void) {
  let buffer = Buffer.alloc(0);
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        // 머리는 수십 바이트다. 머리 끝 없이 쌓이기만 하는 출력(프레임 없는 로그)은 버려서 버퍼가 끝없이 커지지 않게 한다.
        if (buffer.length > MAX_HEADER_BYTES) buffer = Buffer.alloc(0);
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      const bodyStart = headerEnd + 4;
      // Content-Length 가 없는 머리는 건너뛴다. 그대로 두면 길이가 NaN 이라 버퍼가 줄지 않고 이 반복이 끝나지 않아 데몬이 멈춘다.
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
