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

export function frameBlockReason(headers: Headers): string | null {
  const xfo = headers.get("x-frame-options")?.trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") return `X-Frame-Options: ${xfo.toUpperCase()}`;
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
