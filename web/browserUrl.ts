// Browser 탭의 주소 처리. DOM 을 건드리지 않아 단위 시험이 그대로 부른다.
import type { BrowserSearchEngine, BrowserStorage } from "../shared/protocol";
import { S } from "./strings";

export type Address = { ok: true; url: string } | { ok: false; reason: string };

// 앱(Electron)의 webview 가 쓰는 partition. 앱 창과 쿠키, 저장소를 나누고 메인 프로세스(electron/main.ts)가 이 값을 강제한다.
export const BROWSER_PARTITION = "persist:agent-nav-browser";

export type { BrowserStorage };
export type EffectiveStorage = "global" | "workspace" | "ephemeral" | "agent";
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40) || "x";

export function partitionFor(storage: BrowserStorage, workspaceId: string | null, tabKey: string): { partition: string; scope: EffectiveStorage } {
  if (storage === "workspace" && workspaceId) return { partition: `${BROWSER_PARTITION}-ws-${slug(workspaceId)}`, scope: "workspace" };
  if (storage === "ephemeral" || storage === "workspace") return { partition: `agent-nav-browser-eph-${slug(tabKey)}`, scope: "ephemeral" };
  if (storage === "agent") return { partition: "agent-nav-browser-agent", scope: "agent" };
  return { partition: BROWSER_PARTITION, scope: "global" };
}

// 메인 프로세스가 <webview> 에 허락하는 partition 의 모양. 이 밖의 값(앱 창과 같은 partition 이나 아무 이름)은 BROWSER_PARTITION 으로 바꾼다.
export const isBrowserPartition = (value: unknown): value is string => typeof value === "string" && /^(persist:agent-nav-browser(-ws-[a-z0-9]{1,40})?|agent-nav-browser-eph-[a-z0-9]{1,40}|agent-nav-browser-agent)$/.test(value);

// 0.0.0.0 과 [::] 도 이 기기의 서버(데몬)로 닿으므로 loopback 과 같이 본다. 토큰이 든 데몬 페이지를 guest 가 열지 못하게 하는 기준이다.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "[::]", "::"]);
const SEARCH_URLS: Record<Exclude<BrowserSearchEngine, "none">, (q: string) => string> = {
  bing: (q) => `https://www.bing.com/search?q=${q}`,
  google: (q) => `https://www.google.com/search?q=${q}`,
  yahoo: (q) => `https://search.yahoo.com/search?p=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${q}`,
};
export const searchUrl = (engine: BrowserSearchEngine, text: string) => (engine === "none" ? null : SEARCH_URLS[engine](encodeURIComponent(text).replace(/%20/g, "+")));

// 주소창에 쓴 글을 열 주소로. http, https 와 file: 만 열고, 다른 스킴(javascript:, data:)은 거절한다.
// 공백 없는 host:port 와 localhost 는 http, 점이 든 이름은 https, 그 밖의 글은 검색이다.
export function resolveAddress(input: string, engine: BrowserSearchEngine = "bing"): Address {
  const search = (text: string): Address => {
    const url = searchUrl(engine, text);
    return url ? { ok: true, url } : { ok: false, reason: S.browserSearchOff };
  };
  const text = input.trim();
  if (!text) return { ok: false, reason: S.browserUrlPlaceholder };
  const hostPort = /^(localhost|\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+(\/|\?|#|$)/i.test(text);
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return /^(https?|file):\/\//i.test(text) && parseOpenable(text) ? { ok: true, url: parseOpenable(text)!.href } : { ok: false, reason: S.browserOnlyHttp };
  }
  if (/\s/.test(text)) return search(text);
  const host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
  const local = LOOPBACK.has(host) || host === "[::1]" || /^(127|10)\.\d+\.\d+\.\d+$|^192\.168\.\d+\.\d+$/.test(host);
  if (local || host.includes(".") || hostPort) {
    const url = parse(`${local || hostPort ? "http" : "https"}://${text.replace(/^\/\//, "")}`);
    if (url) return { ok: true, url: url.href };
  }
  return search(text);
}

// http 와 https 주소만 URL 로, 나머지(file:, javascript:, data:)는 null. 대화 속 링크를 Browser 탭으로 열지, 기본 브라우저로 보낼지 가를 때 쓴다.
export function parseBrowsable(value: string) {
  const url = parse(value);
  return url && (url.protocol === "http:" || url.protocol === "https:") ? url : null;
}

// Browser 탭이 열 수 있는 주소: http, https 와 로컬 파일(file:). 앱(Electron)의 메인 프로세스도 같은 기준으로 guest 가 갈 곳을 거른다.
export function parseOpenable(value: string) {
  const url = parse(value);
  return url && (url.protocol === "http:" || url.protocol === "https:" || (url.protocol === "file:" && url.hostname === "")) ? url : null;
}

// file: 주소의 파일 경로(자동 새로고침이 지켜볼 파일). file: 이 아니면 null.
export function filePathOf(value: string): string | null {
  const url = parse(value);
  if (!url || url.protocol !== "file:" || url.hostname !== "") return null;
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function parse(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// agent-nav 자기 자신(데몬 주소)이면 true. 같은 포트의 loopback 이름(localhost, 127.0.0.1)도 같은 서버라 막는다.
export function isOwnOrigin(url: string, own: { hostname: string; port: string; origin: string }) {
  const target = parse(url);
  if (!target) return false;
  if (target.origin === own.origin) return true;
  return LOOPBACK.has(target.hostname) && LOOPBACK.has(own.hostname) && target.port === own.port;
}

export const tabLabel = (title: string) => title.trim() || S.browserTabTitle;
export function tabTooltip(title: string, url: string) {
  const host = parse(url)?.host ?? "";
  if (!title.trim() || !host) return tabLabel(title);
  // 웹 접속에서는 페이지 제목을 못 읽어 제목이 host 다
  return title.trim() === host ? url : `${title.trim()} (${host})`;
}

export function localhostTarget(href: string, own: { hostname: string; port: string; origin: string }): string | null {
  const url = parseBrowsable(href);
  if (!url || !LOOPBACK.has(url.hostname) || isOwnOrigin(url.href, own)) return null;
  return url.href;
}

export function similarPage(existing: string, wanted: string, includeBlank = false): boolean {
  let want: URL;
  try {
    want = new URL(wanted);
  } catch {
    return false;
  }
  if (want.protocol !== "file:" && !want.host) return false;
  if (includeBlank && (!existing || existing === "about:blank")) return true;
  let have: URL;
  try {
    have = new URL(existing);
  } catch {
    return false;
  }
  return have.host === want.host || (want.protocol === "file:" && have.protocol === "file:") || !!(have.host && want.host && (have.host.endsWith(`.${want.host}`) || want.host.endsWith(`.${have.host}`)));
}

