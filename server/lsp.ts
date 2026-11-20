import type { WebSocket } from "ws";
import { LspMultiplexer } from "./lspMux";
import { LANGUAGE_SERVERS, planChildren, type LanguageServerSpec } from "./lspRegistry";

// 브라우저의 /ws/lsp 연결 하나를 언어 서버 여럿에 이어 준다. 브라우저는 서버 하나와 말하는 것으로 알고 있다.
// 어떤 서버를 어디에 띄울지는 레지스트리(server/lspRegistry.ts)가 정하고, 요청과 응답을 나누고 합치는 일은 멀티플렉서(server/lspMux.ts)가 한다.
// 브라우저 쪽 Transport 는 헤더 없는 JSON 문자열을 쓴다. 서버 stdio 의 Content-Length 프레이밍은 각 서버 연결이 맡는다.
export function bridgeLsp(socket: WebSocket, workspaceDir: string, servers: readonly LanguageServerSpec[] = LANGUAGE_SERVERS) {
  // 브라우저는 열리자마자 initialize 를 보낸다. 서버를 고르는 동안(비동기) 받은 메시지는 쌓아 두었다가 멀티플렉서가 만들어지면 비운다.
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
