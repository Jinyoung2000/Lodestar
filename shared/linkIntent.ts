
export const SIMULATOR_SCHEMES = ["karrot:", "karrot.alpha:"] as const;

const MAX_LINK_LENGTH = 4096;

export type LinkAction =
  | { kind: "browser"; url: string }
  | { kind: "simulator"; url: string }
  | { kind: "simulatorWebview"; url: string; remote: string };

export function linkActions(input: string): LinkAction[] {
  const text = input.trim();
  if (!text || text.length > MAX_LINK_LENGTH || hasUnsafeChar(text)) return [];
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === "http" || name === "https") return webActions(`${name}${text.slice(name.length)}`);
    const protocol = `${name}:`;
    if (!(SIMULATOR_SCHEMES as readonly string[]).includes(protocol) || !parses(text)) return [];
    return [{ kind: "simulator", url: `${name}${text.slice(name.length)}` }];
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:[/?#]|$)/i.test(text) && portOk(text)) return webActions(`http://${text}`);
  return [];
}

export function webviewUrl(remote: string): string {
  return `karrot.alpha://minikarrot/router?remote=${encodeURIComponent(remote)}&navbar=false&scrollable=false`;
}

export function simulatorUrlOk(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_LINK_LENGTH || value !== value.trim() || hasUnsafeChar(value)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(value);
  return !!scheme && (SIMULATOR_SCHEMES as readonly string[]).includes(scheme[1].toLowerCase()) && parses(value);
}

function webActions(candidate: string): LinkAction[] {
  const url = tryParse(candidate);
  if (!url || !url.hostname || (url.protocol !== "http:" && url.protocol !== "https:")) return [];
  const browser: LinkAction = { kind: "browser", url: url.href };
  if (!isLoopback(url.hostname)) return [browser];
  return [browser, { kind: "simulatorWebview", url: webviewUrl(url.href), remote: url.href }];
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function portOk(text: string) {
  const port = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})/i.exec(text)?.[1];
  return port !== undefined && Number(port) <= 65535;
}

function hasUnsafeChar(value: string) {
  return /[\s\u0000-\u001f\u007f]/.test(value);
}

function parses(value: string) {
  return tryParse(value) !== null;
}

function tryParse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
