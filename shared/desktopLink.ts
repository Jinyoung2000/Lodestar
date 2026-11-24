import type { MobileHost } from "./mobile";
import { encodeText, fromBase64Url, RELAY_KEY_BYTES, toBase64Url } from "./relayNoise";
import { REMOTE_WINDOW_QUERY } from "./windows";

export const DESKTOP_LINK_PROTOCOL = 1;
export const DESKTOP_LINK_PATH = "/link";
export const DESKTOP_LINK_PROLOGUE = encodeText("lodestar-desktop-link-v1");
export const REMOTE_QUERY = REMOTE_WINDOW_QUERY;
export const REMOTE_PREFIX = "/remote";
export const REMOTE_ID_RE = /^[0-9a-f]{16}$/;

export const LINK_WS_PATHS = ["/ws/rpc", "/ws/pty", "/ws/lsp"] as const;
export type LinkWsPath = (typeof LINK_WS_PATHS)[number];
export const LINK_HTTP_PATHS = ["/media", "/attachments"] as const;
export type LinkHttpPath = (typeof LINK_HTTP_PATHS)[number];

export type LinkHello =
  | { v: 1; kind: "pair"; code: string; name: string }
  | { v: 1; kind: "ping" }
  | { v: 1; kind: "ws"; path: LinkWsPath; query: string }
  | { v: 1; kind: "http"; method: "GET" | "HEAD" | "POST"; path: LinkHttpPath; query: string; headers: Record<string, string> };

export type LinkWelcome = { ok: true; protocol: number; name: string; version: string } | { ok: false; error: string };

export const LinkFrame = { ready: 0, text: 1, binary: 2, close: 3, head: 4, body: 5, end: 6 } as const;

export const LINK_REQUEST_HEADERS = ["range", "content-length", "content-type"] as const;
export const LINK_RESPONSE_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "x-content-type-options", "content-security-policy", "cross-origin-resource-policy", "referrer-policy", "allow"] as const;

export const REMOTE_DENIED_METHODS: ReadonlySet<string> = new Set([
  "workspaces.reveal",
  "files.reveal",
  "files.openInVSCode",
  "workspaces.openInVSCode",
  "agents.openChatFile",
  "app.showAgent",
  "browser.setShares",
  "browser.toolResult",
  "daemon.restartIfIdle",
  "feedback.create",
  "feedback.revert",
  "feedback.restart",
  "feedback.retryChecks",
  "feedback.runAgain",
  "feedback.tidyRun",
  "mobile.pairingCode",
  "mobile.revokeDevice",
  "desktopLink.status",
  "desktopLink.pairingOffer",
  "desktopLink.revokePeer",
  "desktopLink.addRemote",
  "desktopLink.removeRemote",
  "desktopLink.checkRemote",
]);

export const REMOTE_LOCKED_SETTINGS: readonly string[] = ["useProviderEnv", "mobileAccess", "mobileRelay", "desktopLink", "autoUpdateWhenIdle"];

export function remoteDenial(method: unknown, params: unknown): string | null {
  if (typeof method !== "string") return "bad request";
  if (REMOTE_DENIED_METHODS.has(method)) return "This works only on that Mac itself, not from another Mac";
  if (method === "settings.set" && params && typeof params === "object") {
    const locked = REMOTE_LOCKED_SETTINGS.find((key) => key in params);
    if (locked) return `The ${locked} setting can be changed only on that Mac`;
  }
  return null;
}

export type LinkOffer = { name: string; hosts: string[]; port: number; key: string; code: string };

const OFFER_PREFIX = "lodestar-link:1:";

export function encodeLinkOffer(offer: LinkOffer): string {
  return OFFER_PREFIX + toBase64Url(encodeText(JSON.stringify({ n: offer.name, h: offer.hosts, p: offer.port, k: offer.key, c: offer.code })));
}

export function decodeLinkOffer(text: unknown): LinkOffer | null {
  if (typeof text !== "string") return null;
  const trimmed = text.replace(/\s+/g, "");
  if (!trimmed.startsWith(OFFER_PREFIX) || trimmed.length > 4096) return null;
  const bytes = fromBase64Url(trimmed.slice(OFFER_PREFIX.length));
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { n?: unknown; h?: unknown; p?: unknown; k?: unknown; c?: unknown };
    const key = typeof value.k === "string" ? fromBase64Url(value.k) : null;
    if (!key || key.length !== RELAY_KEY_BYTES) return null;
    if (!Array.isArray(value.h) || value.h.length === 0 || value.h.length > 16 || !value.h.every(isLinkAddress)) return null;
    if (typeof value.p !== "number" || !Number.isInteger(value.p) || value.p < 1 || value.p > 65535) return null;
    if (typeof value.c !== "string" || !/^[A-Z0-9]{8}$/.test(value.c)) return null;
    return { name: cleanLinkName(value.n) || "Mac", hosts: value.h, port: value.p, key: value.k as string, code: value.c };
  } catch {
    return null;
  }
}

export function isLinkAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}

export function cleanLinkName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "";
}

export function keyFingerprint(key: string): string {
  return key.slice(0, 4) + " " + key.slice(4, 8) + " " + key.slice(8, 12);
}

export type LinkPeer = { id: string; name: string; fingerprint: string; createdAt: string; lastSeenAt: string | null; online: boolean };
export type LinkRemote = { id: string; name: string; address: string; fingerprint: string; pairedAt: string };
export type LinkRemoteCheck = { ok: true; name: string; version: string; sameVersion: boolean } | { ok: false; error: string };

export type DesktopLinkStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  hosts: MobileHost[];
  error: string | null;
  name: string;
  fingerprint: string;
  peers: LinkPeer[];
  remotes: LinkRemote[];
};

export type LinkOfferResult = { text: string; expiresAt: number };

export type DesktopLinkRpcMethods = {
  "desktopLink.status": { params: Record<string, never>; result: DesktopLinkStatus };
  "desktopLink.pairingOffer": { params: Record<string, never>; result: LinkOfferResult };
  "desktopLink.revokePeer": { params: { id: string }; result: DesktopLinkStatus };
  "desktopLink.addRemote": { params: { offer: string }; result: DesktopLinkStatus };
  "desktopLink.removeRemote": { params: { id: string }; result: DesktopLinkStatus };
  "desktopLink.checkRemote": { params: { id: string }; result: LinkRemoteCheck };
};

export function remoteIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(REMOTE_QUERY);
  return value !== null && REMOTE_ID_RE.test(value) ? value : null;
}

export function splitRemotePath(pathname: string): { id: string; path: string } | null {
  const match = /^\/remote\/([0-9a-f]{16})(\/.*)$/.exec(pathname);
  return match ? { id: match[1], path: match[2] } : null;
}
