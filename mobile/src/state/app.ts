import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { RpcClient } from "../net/rpc";
import { pairWithHost, type PairOutcome } from "../net/pair";
import { pairOverRelay } from "../net/relay";
import type { PairingInfo } from "../logic/pairing";
import { routeLabel, routesFromAddress, type ConnectionRoute } from "../logic/routes";
import { clearConnection, asyncCache, loadConnection, saveConnection, type Connection } from "./storage";
import type { SessionSort } from "@shared/protocol";
import { DEFAULT_SESSION_SORT } from "../logic/workspaces";
import { SortPrefsStore, type SortPrefs } from "./sortPrefs";
import { AppStore, type State } from "./store";
import { markEnd, markStart, record } from "./perf";

import { clearSessionViews } from "./sessionView";
import { alertsEnabled, startAlerts, stopAlerts } from "./activity";

markStart("launch-list");

export const client = new RpcClient({
  log: (line) => console.log(line),
  onCall: (method, ms, ok) => method !== "mobile.ping" && record(`rpc ${method}`, ms, ok ? undefined : "failed"),
});
if (AppState.currentState === "background" || AppState.currentState === "inactive") client.pause();
export const store = new AppStore(asyncCache);
store.attach(client);
export const sortPrefs = new SortPrefsStore(asyncCache);

let connection: Connection | null = null;
let bootstrapped = false;
const connectionListeners = new Set<() => void>();
const setConnection = (next: Connection | null) => {
  connection = next;
  if (next && alertsEnabled() && AppState.currentState === "active") void startAlerts(next).catch(() => {});
  for (const listener of connectionListeners) listener();
};

let booting: Promise<void> | null = null;
export function bootstrap(): Promise<void> {
  booting ??= (async () => {
    const [saved, cached] = await Promise.all([loadConnection(), store.loadCache().catch(() => false), sortPrefs.load()]);
    markEnd("launch-list", cached ? "cache" : "no cache");
    if (saved) {
      setConnection(saved);
      markStart("launch-sync");
      client.configure(saved);
    }
    bootstrapped = true;
    for (const listener of connectionListeners) listener();
  })();
  return booting;
}

let offlineSince: number | null = null;
let foregroundAt: number | null = null;
client.onStatus((status) => {
  console.log(`[conn] ${status}${client.route ? ` via ${routeLabel(client.route)}` : ""}`);
  if (status === "unauthorized") stopAlerts();
  if (status === "offline" && offlineSince === null) offlineSince = Date.now();
  if (status === "online") {
    markEnd("launch-sync", "connected");
    if (offlineSince !== null) record("reconnect", Date.now() - offlineSince, foregroundAt ? "after foreground" : "after drop");
    offlineSince = null;
    foregroundAt = null;
  }
});

AppState.addEventListener("change", (next) => {
  if (next !== "active") {
    client.pause();
    return;
  }
  if (connection && alertsEnabled()) void startAlerts(connection).catch((error) => console.warn("Could not resume session alerts", error));
  foregroundAt = Date.now();
  void client.resume()?.then((ms) => {
    if (ms === undefined) return;
    void store.syncOpenTimelines();
    record("foreground-check", ms, "socket alive");
    foregroundAt = null;
  });
});

async function pairEitherWay(info: PairingInfo, deviceName: string) {
  if (info.relay) {
    const relayed = await pairOverRelay(info.relay, info.code, deviceName);
    if (relayed.ok) return { ...relayed, relay: { ...info.relay, privateKey: relayed.privateKey } };
    if (relayed.reason === "rejected" || info.hosts.length === 0) return relayed;
  }
  const direct = await pairWithHost(info, deviceName);
  return direct.ok ? { ...direct, relay: undefined } : direct;
}

export async function pairAndConnect(info: PairingInfo, deviceName: string): Promise<PairOutcome> {
  const outcome = await pairEitherWay(info, deviceName);
  if (!outcome.ok) return outcome;
  clearSessionViews();
  await store.reset();
  const saved: Connection = {
    routes: routesFromAddress(info),
    token: outcome.result.deviceToken,
    deviceId: outcome.result.deviceId,
    hostName: outcome.result.host,
    pairedAt: new Date().toISOString(),
    ...(outcome.relay ? { relay: outcome.relay } : {}),
  };
  await saveConnection(saved);
  setConnection(saved);
  store.attach(client);
  markStart("launch-sync");
  client.configure(saved);
  return { ok: true, result: outcome.result, host: "host" in outcome ? outcome.host : "relay" };
}

export async function unpair() {
  stopAlerts();
  client.configure(null);
  clearSessionViews();
  await store.reset();
  await clearConnection();
  setConnection(null);
  store.attach(client);
}

export async function updateRoutes(routes: ConnectionRoute[]) {
  if (!connection) return;
  const next = { ...connection, routes };
  await saveConnection(next);
  setConnection(next);
  client.configure(next);
}

export function useAppState<T>(selector: (state: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useSortPrefs(): SortPrefs {
  return useSyncExternalStore(sortPrefs.subscribe, sortPrefs.getState);
}

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
