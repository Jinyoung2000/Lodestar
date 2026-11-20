// 앱 전체가 쓰는 연결과 저장소(하나뿐). 시작할 때 캐시와 저장된 연결을 읽고, 앱이 앞으로 오면 바로 다시 붙는다.
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { RpcClient } from "../net/rpc";
import { pairWithHost, type PairOutcome } from "../net/pair";
import type { PairingInfo } from "../logic/pairing";
import { clearConnection, asyncCache, loadConnection, saveConnection, type Connection } from "./storage";
import type { SessionSort } from "@shared/protocol";
import { DEFAULT_SESSION_SORT } from "../logic/workspaces";
import { SortPrefsStore, type SortPrefs } from "./sortPrefs";
import { AppStore, type State } from "./store";
import { markEnd, markStart, record } from "./perf";

markStart("launch-list");

export const client = new RpcClient({
  log: (line) => console.log(line),
  // 핑을 뺀 호출의 왕복 시간(데몬이 처리하고 응답이 오기까지)
  onCall: (method, ms, ok) => method !== "mobile.ping" && record(`rpc ${method}`, ms, ok ? undefined : "failed"),
});
export const store = new AppStore(asyncCache);
store.attach(client);
// 정렬 설정(프로젝트 목록 정렬과 수동 순서, 프로젝트 화면마다의 세션 정렬). 이 폰에만 저장한다.
export const sortPrefs = new SortPrefsStore(asyncCache);

let connection: Connection | null = null;
let bootstrapped = false;
const connectionListeners = new Set<() => void>();
const setConnection = (next: Connection | null) => {
  connection = next;
  for (const listener of connectionListeners) listener();
};

// 시작: 캐시한 목록을 먼저 채우고(화면이 바로 뜬다), 저장된 연결로 붙는다.
let booting: Promise<void> | null = null;
export function bootstrap(): Promise<void> {
  booting ??= (async () => {
    // 정렬 설정도 첫 화면 전에 읽어서, 목록이 기본 순서로 그려졌다가 바뀌는 일이 없게 한다.
    const [saved, cached] = await Promise.all([loadConnection(), store.loadCache(), sortPrefs.load()]);
    markEnd("launch-list", cached ? "cache" : "no cache");
    if (saved) {
      setConnection(saved);
      markStart("launch-sync");
      client.configure({ hosts: saved.hosts, port: saved.port, token: saved.token });
    }
    bootstrapped = true;
    for (const listener of connectionListeners) listener();
  })();
  return booting;
}

// 연결이 끊겼다 돌아오기까지 걸린 시간과, 시작 때 첫 동기화까지 걸린 시간을 기록한다.
let offlineSince: number | null = null;
let foregroundAt: number | null = null;
client.onStatus((status) => {
  console.log(`[conn] ${status}${client.host ? ` via ${client.host}` : ""}`);
  if (status === "offline" && offlineSince === null) offlineSince = Date.now();
  if (status === "online") {
    markEnd("launch-sync", "connected");
    if (offlineSince !== null) record("reconnect", Date.now() - offlineSince, foregroundAt ? "after foreground" : "after drop");
    offlineSince = null;
    foregroundAt = null;
  }
});

AppState.addEventListener("change", (next) => {
  if (next !== "active") return;
  foregroundAt = Date.now();
  if (client.status === "online") {
    const started = Date.now();
    void client.call("mobile.ping", {}, 1500).then(() => record("foreground-check", Date.now() - started, "socket alive")).catch(() => {});
  }
  client.resume();
});

export async function pairAndConnect(info: PairingInfo, deviceName: string): Promise<PairOutcome> {
  const outcome = await pairWithHost(info, deviceName);
  if (!outcome.ok) return outcome;
  // 이전 Mac 의 캐시를 비우고 새 연결을 저장한다. 먼저 응답한 주소를 앞에 둔다.
  await store.reset();
  const saved: Connection = {
    hosts: [outcome.host, ...info.hosts.filter((h) => h !== outcome.host)],
    port: info.port,
    token: outcome.result.deviceToken,
    deviceId: outcome.result.deviceId,
    hostName: outcome.result.host,
    pairedAt: new Date().toISOString(),
  };
  await saveConnection(saved);
  setConnection(saved);
  store.attach(client);
  markStart("launch-sync");
  client.configure({ hosts: saved.hosts, port: saved.port, token: saved.token });
  return outcome;
}

export async function unpair() {
  client.configure(null);
  await store.reset();
  await clearConnection();
  setConnection(null);
  store.attach(client);
}

// 주소를 바꿔 다시 붙는다(Wi-Fi 가 바뀌어 Mac 의 IP 가 달라졌을 때)
export async function updateHosts(hosts: string[], port: number) {
  if (!connection) return;
  const next = { ...connection, hosts, port };
  await saveConnection(next);
  setConnection(next);
  client.configure({ hosts, port, token: next.token });
}

export function useAppState<T>(selector: (state: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useSortPrefs(): SortPrefs {
  return useSyncExternalStore(sortPrefs.subscribe, sortPrefs.getState);
}

// 프로젝트 화면의 세션 정렬. 그 프로젝트에서 고른 적이 없으면 전역 기본값.
export function useSessionSort(workspaceId: string): SessionSort {
  return useSyncExternalStore(sortPrefs.subscribe, () => sortPrefs.getState().sessions[workspaceId] ?? DEFAULT_SESSION_SORT);
}

export function useConnection(): { connection: Connection | null; bootstrapped: boolean } {
  const subscribe = (listener: () => void) => {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  };
  const saved = useSyncExternalStore(subscribe, () => connection);
  const done = useSyncExternalStore(subscribe, () => bootstrapped);
  return { connection: saved, bootstrapped: done };
}
