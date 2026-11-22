import { rpc } from "./rpc";
import { addTerminal, getState, openAgent, openFile, setLayoutMode, setState } from "./store";
import { toggleBottomPanel } from "./terminalScope";
import { setCollapsedGroups, setSessionView } from "./sessionListState";
import { scrollToSubagent } from "./Subagents";
import { showMessage } from "./toBoardState";

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
