
export const DEFAULT_PORT = 7789;

export type PairingInfo = { hosts: string[]; port: number; code: string; name: string | null };

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isLocalNetworkHost(host: string): boolean {
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

export function parseFields(addressText: string, codeText: string): PairingInfo | null {
  return parseManual(`${addressText.trim()} ${codeText.trim()}`);
}
