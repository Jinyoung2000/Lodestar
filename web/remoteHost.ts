import { useSyncExternalStore } from "react";
import type { LinkHostInfo } from "../shared/desktopLink";
import { REMOTE_ID } from "./remote";
import { rpc } from "./rpc";

let host: LinkHostInfo | null = null;
let started = false;
const listeners = new Set<() => void>();

function load() {
  void rpc.call("desktopLink.host", {}).then((next) => {
    host = next;
    for (const listener of listeners) listener();
  }, () => undefined);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started && REMOTE_ID) {
    started = true;
    load();
    rpc.onStatus((connected) => connected && load());
  }
  return () => listeners.delete(listener);
}

export const useRemoteHost = () => useSyncExternalStore(subscribe, () => host);
