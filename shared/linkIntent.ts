// CMDT: ⌘T 입력창에 적은 글이 링크 모양인지 가르는 순수 함수. 웹 화면(web/Overlays.tsx)과 데몬(server/simulator.ts)이 같은 허용 scheme 을 쓴다.

// 시뮬레이터에 넘길 수 있는 scheme 은 이 둘뿐이다. 데몬이 xcrun 에 주는 주소의 허용 범위이기도 하다.
export const SIMULATOR_SCHEMES = ["karrot:", "karrot.alpha:"] as const;

const MAX_LINK_LENGTH = 4096;

// remote 는 localhost 주소를 알파 앱 웹뷰로 여는 주소(simulatorWebview)가 감싼 원래 주소다.
export type LinkAction =
  | { kind: "browser"; url: string }
  | { kind: "simulator"; url: string }
  | { kind: "simulatorWebview"; url: string; remote: string };

// 글이 링크면 실행할 줄들을 위에서부터 순서대로, 링크가 아니면 빈 배열.
// http, https 는 Browser 탭. karrot, karrot.alpha 는 시뮬레이터. localhost 와 127.0.0.1 은 Browser 탭과 시뮬레이터 웹뷰 둘.
// 포트 없는 localhost 같은 맨 글자는 심볼 이름일 수 있어 링크로 보지 않는다. scheme 이 없는 주소는 포트가 있을 때만 http 로 본다.
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

// 알파 앱의 미니 웹뷰(minikarrot router)로 로컬 주소를 여는 주소. remote 값은 전부 percent-encoding 한다.
export function webviewUrl(remote: string): string {
  return `karrot.alpha://minikarrot/router?remote=${encodeURIComponent(remote)}&navbar=false&scrollable=false`;
}

// 데몬이 xcrun 에 넘기기 전에 다시 거르는 검사. 허용 scheme 의 주소 하나만 통과한다.
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

// 공백과 제어문자가 든 글은 링크가 아니다(심볼 이름이나 문장, 셸 해석을 노린 값)
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
