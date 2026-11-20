// 페어링 정보 읽기. QR 은 lodestar://pair?... 주소이고, 수동 입력은 "192.168.0.5:7789 ABCD-EFGH" 한 줄이다.
// 데몬이 만드는 모양은 shared/mobile.ts 의 buildPairingUri, buildManualPairing 과 같고 test/pairing.test.ts 가 대조한다.

export const DEFAULT_PORT = 7789;

export type PairingInfo = { hosts: string[]; port: number; code: string; name: string | null };

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// 앱이 붙는 곳은 같은 네트워크의 Mac 이다(사설 IPv4 대역, Tailscale 대역, .local, Tailscale 이름). 안드로이드 릴리스 빌드는 평문 ws:// 를 앱 전체에 허용하므로(plugins/android-release.js),
// QR 이나 입력이 공인 주소를 가리켜도 앱이 따라가지 않게 여기서 거른다.
export function isLocalNetworkHost(host: string): boolean {
  // 이름 자체가 호스트 모양이어야 한다. "x@evil.com#.local" 이나 "evil.com/.local" 은 끝만 .local 이고 실제로는 evil.com 에 붙는다(설정의 주소 바꾸기가 이 함수만 쓴다).
  if (!HOST_RE.test(host)) return false;
  const name = host.toLowerCase();
  if (name === "localhost" || name.endsWith(".local") || name.endsWith(".ts.net")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

// 주소(lodestar://pair?...)나 수동 입력 문자열에서 호스트 후보, 포트, 코드를 읽는다. 읽을 수 없으면 null.
export function parsePairing(raw: string): PairingInfo | null {
  const text = raw.trim();
  if (text.startsWith("lodestar://")) return parseUri(text);
  return parseManual(text);
}

function parseUri(text: string): PairingInfo | null {
  const query = text.split("?")[1];
  if (!query) return null;
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const [key, ...rest] = pair.split("=");
    try {
      params.set(key, decodeURIComponent(rest.join("=").replace(/\+/g, " ")));
    } catch {
      return null;
    }
  }
  const hosts = (params.get("h") ?? "").split(",").map((h) => h.trim()).filter((h) => HOST_RE.test(h) && isLocalNetworkHost(h));
  const port = Number(params.get("p") ?? DEFAULT_PORT);
  const code = normalizeCode(params.get("c") ?? "");
  if (hosts.length === 0 || !validPort(port) || !CODE_RE.test(code)) return null;
  return { hosts, port, code, name: params.get("n") || null };
}

// "192.168.0.5:7789 ABCD-EFGH", "192.168.0.5:7789#ABCD2345", "mac.local ABCD-EFGH"(포트 생략은 기본 포트)
function parseManual(text: string): PairingInfo | null {
  const match = /^([^\s#]+)[\s#]+([A-Za-z0-9-]{8,9})$/.exec(text);
  if (!match) return null;
  const [, address, rawCode] = match;
  const [host, portText] = address.split(":");
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  const code = normalizeCode(rawCode);
  if (!HOST_RE.test(host) || !isLocalNetworkHost(host) || !validPort(port) || !CODE_RE.test(code)) return null;
  return { hosts: [host], port, code, name: null };
}

// 주소 칸과 코드 칸을 따로 받는 입력(수동 입력 화면)
export function parseFields(addressText: string, codeText: string): PairingInfo | null {
  return parseManual(`${addressText.trim()} ${codeText.trim()}`);
}
