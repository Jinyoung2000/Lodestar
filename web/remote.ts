import { REMOTE_PREFIX, remoteIdFromSearch } from "../shared/desktopLink";

export const REMOTE_ID: string | null = typeof location === "undefined" ? null : remoteIdFromSearch(location.search);

export const daemonPath = (path: string) => (REMOTE_ID ? `${REMOTE_PREFIX}/${REMOTE_ID}${path}` : path);

export const localNative = () => (REMOTE_ID ? undefined : window.agentNavNative);
