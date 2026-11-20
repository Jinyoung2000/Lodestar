import { rpc } from "./rpc";
import { addTerminal, getState, openAgent, openFile, setLayoutMode, setState } from "./store";
import { toggleBottomPanel } from "./terminalScope";
import { setCollapsedGroups, setSessionView } from "./sessionListState";
import { scrollToSubagent } from "./Subagents";
import { showMessage } from "./toBoardState";

// 성능 계측 전용 창구(`vite build --mode perf` 시험 번들에서만). 데몬이 보내는 것과 같은 웹소켓 메시지를 rpc 수신 경로에 직접 넣어 가짜 스트리밍을 만든다.
// 렌더 카운터는 web/perfCounter.ts 가 맡는다. showMessage 와 scrollToSubagent 는 접힌 단계 묶음 안으로 이동하는 길을 시험 스크립트가 부르려고 연다.
export function installPerfHook() {
  if (import.meta.env.MODE !== "perf") return;
  const perf = window.__navPerf;
  if (!perf) return;
  perf.emitText = (text) => {
    const socket = (rpc as unknown as { socket: { onmessage: (m: { data: string }) => void } }).socket;
    socket.onmessage({ data: text });
  };
  perf.emit = (event) => perf.emitText?.(JSON.stringify({ event }));
  perf.getState = getState;
  perf.actions = { openAgent, openFile: (target) => openFile(target as Parameters<typeof openFile>[0]), addTerminal, setLayoutMode: (mode) => setLayoutMode(mode as Parameters<typeof setLayoutMode>[0]), toggleBottomPanel };
  perf.setState = setState as (patch: unknown) => void;
  perf.showMessage = showMessage;
  perf.scrollToSubagent = scrollToSubagent;
  perf.sessionList = { setSessionView: (patch) => setSessionView(patch as Parameters<typeof setSessionView>[0]), setCollapsedGroups };
}
