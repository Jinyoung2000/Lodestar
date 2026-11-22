import type { WebSocket } from "ws";
import { LspMultiplexer } from "./lspMux";
import { LANGUAGE_SERVERS, planChildren, type LanguageServerSpec } from "./lspRegistry";

// 브라우저 쪽 Transport 는 헤더 없는 JSON 문자열을 쓴다. 서버 stdio 의 Content-Length 프레이밍은 각 서버 연결이 맡는다.
export function bridgeLsp(socket: WebSocket, workspaceDir: string, servers: readonly LanguageServerSpec[] = LANGUAGE_SERVERS) {
  const early: string[] = [];
  let mux: LspMultiplexer | null = null;
  let closed = false;

  socket.on("message", (data) => {
    const text = data.toString();
    if (mux) mux.fromBrowser(text);
    else early.push(text);
  });
  socket.on("close", () => {
    closed = true;
    mux?.dispose();
  });

  void planChildren(workspaceDir, servers).then((children) => {
    if (closed) return;
    mux = new LspMultiplexer(children, {
      toBrowser: (text) => {
        if (socket.readyState === socket.OPEN) socket.send(text);
      },
      closeBrowser: (code, reason) => {
        if (socket.readyState === socket.OPEN) socket.close(code, reason);
      },
    });
    for (const text of early.splice(0)) mux.fromBrowser(text);
  });
}
