// 웹(브라우저 접속) 모드의 Browser 탭은 iframe 으로 주소를 연다. 브라우저는 X-Frame-Options 로 거절당한 iframe 을 load 이벤트만 띄워서 화면이 빈 이유를 알 수 없다.
// 그래서 데몬이 같은 주소를 한 번 받아 응답 머리만 읽고 iframe 으로 열 수 있는지 알려 준다.
export type FrameProbe = { ok: boolean; status: number | null; reason: string | null };

const TIMEOUT_MS = 4000;

export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// 응답 머리가 다른 출처의 iframe 을 막으면 그 이유. 막지 않으면 null.
export function frameBlockReason(headers: Headers): string | null {
  const xfo = headers.get("x-frame-options")?.trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") return `X-Frame-Options: ${xfo.toUpperCase()}`;
  // frame-ancestors 가 모든 출처(*, http:, https:)를 허용하지 않으면 우리 주소는 허용 목록에 없다고 본다.
  const csp = headers.get("content-security-policy") ?? "";
  for (const directive of csp.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name?.toLowerCase() !== "frame-ancestors") continue;
    const open = sources.some((s) => s === "*" || s === "http:" || s === "https:");
    return open ? null : `Content-Security-Policy: frame-ancestors ${sources.join(" ")}`;
  }
  return null;
}

export async function probeFrame(value: string): Promise<FrameProbe> {
  const url = parseHttpUrl(value);
  if (!url) return { ok: false, status: null, reason: "Only http and https addresses can be opened" };
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/html" } });
    void response.body?.cancel().catch(() => undefined);
    const blocked = frameBlockReason(response.headers);
    return { ok: blocked === null, status: response.status, reason: blocked };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { ok: false, status: null, reason: cause === "ECONNREFUSED" ? `Nothing is listening on ${url.host}` : `Could not reach ${url.host}` };
  }
}
