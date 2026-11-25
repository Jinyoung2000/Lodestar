import { DurableObject } from "cloudflare:workers";

type Env = { RELAY: DurableObjectNamespace<RelayRoom> };
type Attachment = { role: "host"; resume?: true } | { role: "client"; channel: number; resume?: true };

const ROUTE_RE = /^\/v1\/(host|client)\/([0-9a-f]{32})$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
const MAX_CLIENTS = 16;
const MAX_FRAME_BYTES = 1024 * 1024;
const CLOSE_OFFLINE = 4404;
const CLOSE_FULL = 4429;
const CLOSE_REPLACED = 4000;
const HOST_GRACE_MS = 20_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const route = ROUTE_RE.exec(url.pathname);
    if (!route) return new Response("not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    return env.RELAY.get(env.RELAY.idFromName(route[2])).fetch(request);
  },
};

function resumeControl(text: string): number | null {
  if (text.length > 96) return null;
  try {
    const rx = (JSON.parse(text) as { rx?: unknown }).rx;
    return typeof rx === "number" && Number.isInteger(rx) && rx >= 0 ? rx : null;
  } catch {
    return null;
  }
}

const toHex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

function closeQuietly(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    return;
  }
}

export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = ROUTE_RE.exec(url.pathname)?.[1];
    const resume = url.searchParams.get("resume") === "1";
    if (role === "host") return this.acceptHost(request, resume);
    if (role === "client") return this.acceptClient(resume);
    return new Response("not found", { status: 404 });
  }

  private async acceptHost(request: Request, resume: boolean): Promise<Response> {
    const secret = request.headers.get("x-relay-secret") ?? "";
    if (!SECRET_RE.test(secret)) return new Response("unauthorized", { status: 401 });
    const digest = toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
    const stored = await this.ctx.storage.get<string>("secret");
    if (stored !== undefined && stored !== digest) return new Response("unauthorized", { status: 401 });
    if (stored === undefined) await this.ctx.storage.put("secret", digest);
    for (const old of this.ctx.getWebSockets("host")) {
      old.serializeAttachment(null);
      closeQuietly(old, CLOSE_REPLACED, "replaced");
    }
    const kept: number[] = [];
    for (const client of this.ctx.getWebSockets("client")) {
      const attachment = client.deserializeAttachment() as Attachment | null;
      if (resume && attachment?.role === "client" && attachment.resume && client.readyState === WebSocket.OPEN) kept.push(attachment.channel);
      else closeQuietly(client, CLOSE_OFFLINE, "mac reconnected");
    }
    await this.ctx.storage.deleteAlarm();
    const { 0: remote, 1: local } = new WebSocketPair();
    this.ctx.acceptWebSocket(local, ["host"]);
    local.serializeAttachment({ role: "host", ...(resume ? { resume: true as const } : {}) } satisfies Attachment);
    for (const channel of kept) local.send(JSON.stringify({ t: "open", c: channel, resume: true }));
    return new Response(null, { status: 101, webSocket: remote });
  }

  private acceptClient(resume: boolean): Response {
    const { 0: remote, 1: local } = new WebSocketPair();
    const host = this.host();
    const clients = this.ctx.getWebSockets("client").filter((ws) => ws.readyState === WebSocket.OPEN);
    if (!host || clients.length >= MAX_CLIENTS) {
      this.ctx.acceptWebSocket(local, ["rejected"]);
      local.close(host ? CLOSE_FULL : CLOSE_OFFLINE, host ? "too many connections" : "mac offline");
      return new Response(null, { status: 101, webSocket: remote });
    }
    const channel = this.freeChannel();
    this.ctx.acceptWebSocket(local, ["client", `c${channel}`]);
    local.serializeAttachment({ role: "client", channel, ...(resume ? { resume: true as const } : {}) } satisfies Attachment);
    host.send(JSON.stringify({ t: "open", c: channel }));
    return new Response(null, { status: 101, webSocket: remote });
  }

  private host(): WebSocket | undefined {
    return this.ctx.getWebSockets("host").find((ws) => ws.readyState === WebSocket.OPEN);
  }

  private freeChannel(): number {
    for (;;) {
      const channel = crypto.getRandomValues(new Uint32Array(1))[0];
      if (channel !== 0 && this.ctx.getWebSockets(`c${channel}`).length === 0) return channel;
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    if (attachment.role === "host") return this.fromHost(message);
    const host = this.host();
    if (typeof message === "string") {
      if (!attachment.resume || !host) return;
      const control = resumeControl(message);
      if (control !== null) host.send(JSON.stringify({ t: "resume", c: attachment.channel, rx: control }));
      return;
    }
    if (message.byteLength > MAX_FRAME_BYTES) return;
    if (!host) {
      if (attachment.resume && (await this.ctx.storage.getAlarm()) !== null) return;
      return closeQuietly(ws, CLOSE_OFFLINE, "mac offline");
    }
    const frame = new Uint8Array(message.byteLength + 4);
    new DataView(frame.buffer).setUint32(0, attachment.channel);
    frame.set(new Uint8Array(message), 4);
    host.send(frame);
  }

  private fromHost(message: string | ArrayBuffer) {
    if (typeof message === "string") {
      let control: { t?: unknown; c?: unknown; code?: unknown; reason?: unknown; rx?: unknown };
      try {
        control = JSON.parse(message);
      } catch {
        return;
      }
      if (control.t === "resume" && typeof control.c === "number") {
        const rx = resumeControl(message);
        if (rx !== null) this.ctx.getWebSockets(`c${control.c}`)[0]?.send(JSON.stringify({ t: "resume", rx }));
        return;
      }
      if (control.t !== "close" || typeof control.c !== "number") return;
      const code = typeof control.code === "number" && control.code >= 4000 && control.code <= 4999 ? control.code : 1000;
      const reason = typeof control.reason === "string" ? control.reason.slice(0, 100) : "";
      for (const client of this.ctx.getWebSockets(`c${control.c}`)) closeQuietly(client, code, reason);
      return;
    }
    if (message.byteLength < 4 || message.byteLength > MAX_FRAME_BYTES + 4) return;
    const channel = new DataView(message).getUint32(0);
    this.ctx.getWebSockets(`c${channel}`)[0]?.send(message.slice(4));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.dropped(ws);
    closeQuietly(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropped(ws);
  }

  private async dropped(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "client") {
      this.host()?.send(JSON.stringify({ t: "close", c: attachment.channel }));
      return;
    }
    if (attachment?.role !== "host") return;
    if (this.ctx.getWebSockets("host").some((other) => other !== ws && other.readyState === WebSocket.OPEN)) return;
    let waiting = false;
    for (const client of this.ctx.getWebSockets("client")) {
      const kept = client.deserializeAttachment() as Attachment | null;
      if (attachment.resume && kept?.role === "client" && kept.resume) waiting = true;
      else closeQuietly(client, CLOSE_OFFLINE, "mac offline");
    }
    if (waiting) await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
  }

  async alarm(): Promise<void> {
    if (this.host()) return;
    for (const client of this.ctx.getWebSockets("client")) closeQuietly(client, CLOSE_OFFLINE, "mac offline");
  }
}
