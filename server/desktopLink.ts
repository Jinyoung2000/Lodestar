import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  cleanLinkName,
  DESKTOP_LINK_PATH,
  DESKTOP_LINK_PROLOGUE,
  DESKTOP_LINK_PROTOCOL,
  keyFingerprint,
  LINK_HTTP_PATHS,
  LINK_REQUEST_HEADERS,
  LINK_RESPONSE_HEADERS,
  LINK_WS_PATHS,
  LinkFrame,
  remoteDenial,
  type LinkHello,
  type LinkPeer,
  type LinkRemote,
  type LinkWelcome,
} from "../shared/desktopLink";
import { concatBytes, decodeText, encodeText, fromBase64Url, RELAY_KEY_BYTES, startInitiator, startResponder, toBase64Url, type RelaySession } from "../shared/relayNoise";
import { AttemptLimiter, type PairingCodes } from "./mobileAccess";
import { nodeNoise } from "./mobileRelay";

const MAX_FRAME_BYTES = 80 * 1024 * 1024;
const BODY_CHUNK_BYTES = 256 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 4_000;
const HEARTBEAT_MS = 20_000;
const SEEN_SAVE_GAP_MS = 60_000;
const MAX_UNAUTHENTICATED = 32;
const EMPTY = new Uint8Array(0);

function writePrivateJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

const bytesOf = (data: RawData): Uint8Array => (Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data);

export type LinkIdentity = { privateKey: Uint8Array; publicKey: Uint8Array; key: string };

export function loadLinkIdentity(file: string): LinkIdentity {
  const stored = readJson<{ privateKey?: unknown }>(file, {});
  let hex = typeof stored.privateKey === "string" && /^[0-9a-f]{64}$/.test(stored.privateKey) ? stored.privateKey : null;
  if (!hex) {
    hex = randomBytes(RELAY_KEY_BYTES).toString("hex");
    writePrivateJson(file, { privateKey: hex });
  }
  const privateKey = Uint8Array.from(Buffer.from(hex, "hex"));
  const publicKey = nodeNoise.publicKey(privateKey);
  return { privateKey, publicKey, key: toBase64Url(publicKey) };
}

type PeerRecord = { id: string; name: string; publicKey: string; createdAt: string; lastSeenAt: string | null };

export class LinkPeers {
  private records: PeerRecord[];
  private savedSeenAt = new Map<string, number>();

  constructor(private file: string) {
    const stored = readJson<PeerRecord[]>(file, []);
    this.records = Array.isArray(stored) ? stored.filter((r) => r && typeof r.id === "string" && typeof r.publicKey === "string") : [];
  }

  list(): PeerRecord[] {
    return this.records;
  }

  byKey(publicKey: string): PeerRecord | null {
    return this.records.find((record) => record.publicKey === publicKey) ?? null;
  }

  add(rawName: unknown, publicKey: string): PeerRecord {
    const record: PeerRecord = { id: randomBytes(8).toString("hex"), name: cleanLinkName(rawName) || "Mac", publicKey, createdAt: new Date().toISOString(), lastSeenAt: null };
    this.records = [...this.records.filter((existing) => existing.publicKey !== publicKey), record];
    writePrivateJson(this.file, this.records);
    return record;
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    writePrivateJson(this.file, this.records);
    return true;
  }

  touch(id: string, now = Date.now()) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    record.lastSeenAt = new Date(now).toISOString();
    if (now - (this.savedSeenAt.get(id) ?? 0) < SEEN_SAVE_GAP_MS) return;
    this.savedSeenAt.set(id, now);
    writePrivateJson(this.file, this.records);
  }
}

export type RemoteRecord = { id: string; name: string; hosts: string[]; port: number; publicKey: string; pairedAt: string; lastHost?: string };

export class LinkRemotes {
  private records: RemoteRecord[];

  constructor(private file: string) {
    const stored = readJson<RemoteRecord[]>(file, []);
    this.records = Array.isArray(stored) ? stored.filter((r) => r && typeof r.id === "string" && typeof r.publicKey === "string" && Array.isArray(r.hosts)) : [];
  }

  list(): RemoteRecord[] {
    return this.records;
  }

  get(id: string): RemoteRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  add(input: Omit<RemoteRecord, "id" | "pairedAt">): RemoteRecord {
    const record: RemoteRecord = { ...input, id: randomBytes(8).toString("hex"), pairedAt: new Date().toISOString() };
    this.records = [...this.records.filter((existing) => existing.publicKey !== input.publicKey), record];
    writePrivateJson(this.file, this.records);
    return record;
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    writePrivateJson(this.file, this.records);
    return true;
  }

  prefer(id: string, host: string) {
    const record = this.get(id);
    if (!record || record.lastHost === host) return;
    record.lastHost = host;
    writePrivateJson(this.file, this.records);
  }
}

export const peerView = (record: PeerRecord, online: boolean): LinkPeer => ({ id: record.id, name: record.name, fingerprint: keyFingerprint(record.publicKey), createdAt: record.createdAt, lastSeenAt: record.lastSeenAt, online });
export const remoteView = (record: RemoteRecord): LinkRemote => ({ id: record.id, name: record.name, address: `${record.lastHost ?? record.hosts[0]}:${record.port}`, fingerprint: keyFingerprint(record.publicKey), pairedAt: record.pairedAt });

export class LinkStream {
  onFrame: (type: number, body: Uint8Array) => void = () => {};
  onClose: () => void = () => {};
  private answered = true;
  private heartbeat: NodeJS.Timeout;

  constructor(private socket: WebSocket, private session: RelaySession) {
    socket.on("message", (data) => {
      let frame: Uint8Array;
      try {
        frame = this.session.open(bytesOf(data));
      } catch {
        socket.close(1008, "bad frame");
        return;
      }
      if (frame.length > 0) this.onFrame(frame[0], frame.subarray(1));
    });
    socket.on("pong", () => (this.answered = true));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearInterval(this.heartbeat);
      this.onClose();
    });
    this.heartbeat = setInterval(() => {
      if (!this.answered) return socket.terminate();
      this.answered = false;
      socket.ping();
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get open() {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(type: number, body: Uint8Array = EMPTY): Promise<void> {
    if (!this.open) return Promise.resolve();
    const sealed = this.session.seal(concatBytes(Uint8Array.of(type), body));
    return new Promise((resolve) => this.socket.send(sealed, { binary: true }, () => resolve()));
  }

  sendJson(type: number, value: unknown) {
    return this.send(type, encodeText(JSON.stringify(value)));
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close(1000);
  }
}

function parseJson<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(decodeText(bytes)) as T;
  } catch {
    return null;
  }
}

function validHello(value: LinkHello | null): value is LinkHello {
  if (!value || typeof value !== "object" || value.v !== 1) return false;
  if (value.kind === "ping") return true;
  if (value.kind === "pair") return typeof value.code === "string" && typeof value.name === "string";
  if (value.kind === "ws") return LINK_WS_PATHS.includes(value.path) && typeof value.query === "string" && value.query.length <= 4096;
  if (value.kind === "http") {
    const methodFits = value.path === "/attachments" ? value.method === "POST" : value.method === "GET" || value.method === "HEAD";
    return LINK_HTTP_PATHS.includes(value.path) && methodFits && typeof value.query === "string" && value.query.length <= 4096 && !!value.headers && typeof value.headers === "object";
  }
  return false;
}

function localQuery(query: string, token: string | null): string {
  const params = new URLSearchParams(query);
  params.delete("token");
  if (token !== null) params.set("token", token);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type LinkServerDeps = {
  identity: LinkIdentity;
  peers: LinkPeers;
  pairing: PairingCodes;
  daemon: { port: number; token: string };
  name: string;
  version: string;
  log?: (line: string) => void;
};

export class DesktopLinkServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sockets = new Map<WebSocket, string | null>();
  private pairAttempts = new AttemptLimiter(10, 60_000);
  port = 0;
  error: string | null = null;

  constructor(private deps: LinkServerDeps) {}

  get listening() {
    return this.http?.listening === true;
  }

  online(peerId: string): boolean {
    for (const id of this.sockets.values()) if (id === peerId) return true;
    return false;
  }

  closePeer(peerId: string) {
    for (const [socket, id] of this.sockets) if (id === peerId) socket.close(1008, "unpaired");
  }

  async start(port: number, bind: string): Promise<void> {
    if (this.http) return;
    this.error = null;
    const server = createServer((_req, res) => void res.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    server.on("upgrade", (req, socket, head) => {
      const reject = (code: number, text: string) => {
        socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
        socket.destroy();
      };
      if (req.headers.origin !== undefined) return reject(403, "Forbidden");
      if (req.url !== DESKTOP_LINK_PATH) return reject(404, "Not Found");
      if (this.unauthenticated() >= MAX_UNAUTHENTICATED) return reject(503, "Service Unavailable");
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bind, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      wss.close();
      throw error;
    }
    server.on("error", (error) => this.deps.log?.(`[link] server error: ${error.message}`));
    this.http = server;
    this.wss = wss;
    this.port = (server.address() as { port: number }).port;
    this.deps.log?.(`[link] listening on ${bind}:${this.port}`);
  }

  async stop(): Promise<void> {
    const server = this.http;
    if (!server) return;
    this.http = null;
    this.deps.pairing.clear();
    for (const socket of this.sockets.keys()) socket.close(1001, "desktop link turned off");
    this.sockets.clear();
    this.wss?.close();
    this.wss = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.deps.log?.("[link] stopped");
  }

  private unauthenticated() {
    let count = 0;
    for (const id of this.sockets.values()) if (id === null) count++;
    return count;
  }

  private accept(socket: WebSocket) {
    this.sockets.set(socket, null);
    const timer = setTimeout(() => socket.close(4408, "handshake timeout"), HANDSHAKE_TIMEOUT_MS);
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
    socket.on("error", () => {});
    socket.once("message", (data) => {
      try {
        this.handshake(socket, bytesOf(data), timer);
      } catch {
        socket.close(1008, "bad handshake");
      }
    });
  }

  private handshake(socket: WebSocket, first: Uint8Array, timer: NodeJS.Timeout) {
    const responder = startResponder(nodeNoise, { staticPrivate: this.deps.identity.privateKey, prologue: DESKTOP_LINK_PROLOGUE });
    const { remoteStatic, payload } = responder.readFirst(first);
    const peerKey = toBase64Url(remoteStatic);
    const hello = parseJson<LinkHello>(payload);
    const admitted = this.admit(hello, peerKey);
    const welcome: LinkWelcome = admitted.ok ? { ok: true, protocol: DESKTOP_LINK_PROTOCOL, name: this.deps.name, version: this.deps.version } : { ok: false, error: admitted.error };
    const { message, session } = responder.writeSecond(encodeText(JSON.stringify(welcome)));
    socket.send(message, { binary: true });
    if (!admitted.ok) {
      socket.close(1008, "refused");
      return;
    }
    this.sockets.set(socket, admitted.peerId);
    const stream = new LinkStream(socket, session);
    let started = false;
    stream.onFrame = (type) => {
      if (started || type !== LinkFrame.ready) return socket.close(1008, "expected ready");
      started = true;
      clearTimeout(timer);
      this.deps.peers.touch(admitted.peerId);
      this.serve(stream, admitted.hello);
    };
  }

  private admit(hello: LinkHello | null, peerKey: string): { ok: true; peerId: string; hello: LinkHello } | { ok: false; error: string } {
    if (!validHello(hello)) return { ok: false, error: "This Mac runs a different version of Lodestar. Update both Macs." };
    if (hello.kind === "pair") {
      if (!this.pairAttempts.take()) return { ok: false, error: "Too many attempts. Wait a minute and try again." };
      const outcome = this.deps.pairing.redeem(hello.code);
      if (outcome !== "ok") return { ok: false, error: outcome === "expired" ? "The pairing text expired. Create a new one." : outcome === "locked" ? "Too many wrong attempts. Create a new pairing text." : "The pairing text is not valid. Create a new one." };
      const peer = this.deps.peers.add(hello.name, peerKey);
      this.deps.log?.(`[link] paired ${peer.name} (${keyFingerprint(peerKey)})`);
      return { ok: true, peerId: peer.id, hello };
    }
    const peer = this.deps.peers.byKey(peerKey);
    if (!peer) return { ok: false, error: "This Mac is no longer paired. Pair it again." };
    return { ok: true, peerId: peer.id, hello };
  }

  private serve(stream: LinkStream, hello: LinkHello) {
    if (hello.kind === "ws") return this.serveSocket(stream, hello);
    if (hello.kind === "http") return this.serveHttp(stream, hello);
    stream.onFrame = () => {};
    setTimeout(() => stream.close(), 1000).unref();
  }

  private serveSocket(stream: LinkStream, hello: Extract<LinkHello, { kind: "ws" }>) {
    const { port, token } = this.deps.daemon;
    const local = new WebSocket(`ws://127.0.0.1:${port}${hello.path}${localQuery(hello.query, token)}`, { origin: `http://127.0.0.1:${port}`, maxPayload: MAX_FRAME_BYTES });
    const held: { data: Uint8Array | string; binary: boolean }[] = [];
    const toLocal = (data: Uint8Array | string, binary: boolean) => {
      if (local.readyState === WebSocket.OPEN) local.send(data, { binary });
      else if (local.readyState === WebSocket.CONNECTING) held.push({ data, binary });
    };
    local.on("open", () => {
      for (const item of held.splice(0)) local.send(item.data, { binary: item.binary });
    });
    local.on("message", (data, isBinary) => void stream.send(isBinary ? LinkFrame.binary : LinkFrame.text, bytesOf(data)));
    local.on("error", () => {});
    local.on("close", (code, reason) => {
      void stream.sendJson(LinkFrame.close, { code, reason: reason.toString().slice(0, 120) }).then(() => stream.close());
    });
    stream.onClose = () => local.close();
    stream.onFrame = (type, body) => {
      if (type === LinkFrame.binary) return toLocal(body, true);
      if (type === LinkFrame.close) return local.close();
      if (type !== LinkFrame.text) return;
      const text = decodeText(body);
      if (hello.path === "/ws/rpc") {
        const request = parseJson<{ id?: unknown; method?: unknown; params?: unknown }>(body);
        const denial = request ? remoteDenial(request.method, request.params) : "bad request";
        if (denial !== null) return void stream.sendJson(LinkFrame.text, { id: request?.id ?? 0, error: denial });
      }
      toLocal(text, false);
    };
  }

  private serveHttp(stream: LinkStream, hello: Extract<LinkHello, { kind: "http" }>) {
    const { port, token } = this.deps.daemon;
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    for (const name of LINK_REQUEST_HEADERS) if (typeof hello.headers[name] === "string") headers[name] = hello.headers[name];
    if (hello.path === "/attachments") {
      headers.origin = `http://127.0.0.1:${port}`;
      headers["x-agent-nav-token"] = token;
    }
    const request = httpRequest({ host: "127.0.0.1", port, method: hello.method, path: `${hello.path}${localQuery(hello.query, null)}`, headers });
    request.on("error", () => stream.close());
    request.on("response", async (response) => {
      const kept: Record<string, string> = {};
      for (const name of LINK_RESPONSE_HEADERS) {
        const value = response.headers[name];
        if (typeof value === "string") kept[name] = value;
      }
      await stream.sendJson(LinkFrame.head, { status: response.statusCode ?? 502, headers: kept });
      for await (const chunk of response as AsyncIterable<Buffer>) {
        if (!stream.open) break;
        for (let at = 0; at < chunk.length; at += BODY_CHUNK_BYTES) await stream.send(LinkFrame.body, chunk.subarray(at, at + BODY_CHUNK_BYTES));
      }
      await stream.send(LinkFrame.end);
      stream.close();
    });
    stream.onClose = () => request.destroy();
    stream.onFrame = (type, body) => {
      if (type === LinkFrame.body) request.write(body);
      else if (type === LinkFrame.end) request.end();
    };
  }
}

export type LinkClientDeps = { identity: LinkIdentity; remotes: LinkRemotes; log?: (line: string) => void };
export type LinkTarget = Pick<RemoteRecord, "hosts" | "port" | "publicKey"> & { lastHost?: string };

function dial(host: string, port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${port}${DESKTOP_LINK_PATH}`, { handshakeTimeout: CONNECT_TIMEOUT_MS, maxPayload: MAX_FRAME_BYTES });
    socket.once("open", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function shake(socket: WebSocket, identity: LinkIdentity, remoteKey: Uint8Array, hello: LinkHello): Promise<{ welcome: LinkWelcome; stream: LinkStream }> {
  return new Promise((resolve, reject) => {
    const initiator = startInitiator(nodeNoise, { staticPrivate: identity.privateKey, prologue: DESKTOP_LINK_PROLOGUE, remoteStatic: remoteKey });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("The other Mac did not answer in time"));
    }, HANDSHAKE_TIMEOUT_MS);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("The connection to the other Mac closed"));
    };
    socket.once("close", fail);
    socket.once("message", (data) => {
      clearTimeout(timer);
      socket.off("close", fail);
      try {
        const { payload, session } = initiator.readSecond(bytesOf(data));
        const welcome = parseJson<LinkWelcome>(payload);
        if (!welcome) throw new Error("bad welcome");
        const stream = new LinkStream(socket, session);
        if (welcome.ok) void stream.send(LinkFrame.ready);
        resolve({ welcome, stream });
      } catch {
        socket.terminate();
        reject(new Error("The other Mac could not prove its identity. Pair it again."));
      }
    });
    socket.send(initiator.writeFirst(encodeText(JSON.stringify(hello))), { binary: true });
  });
}

export async function openLink(identity: LinkIdentity, target: LinkTarget, hello: LinkHello): Promise<{ welcome: LinkWelcome; stream: LinkStream; host: string }> {
  const remoteKey = fromBase64Url(target.publicKey);
  if (!remoteKey || remoteKey.length !== RELAY_KEY_BYTES) throw new Error("The saved key for the other Mac is not valid. Pair it again.");
  const hosts = target.lastHost && target.hosts.includes(target.lastHost) ? [target.lastHost, ...target.hosts.filter((host) => host !== target.lastHost)] : target.hosts;
  let socket: WebSocket | null = null;
  let reached = "";
  for (const host of hosts) {
    socket = await dial(host, target.port).catch(() => null);
    if (socket) {
      reached = host;
      break;
    }
  }
  if (!socket) throw new Error("Could not reach the other Mac. Check that it is awake, Desktop link is on there, and both Macs share a network or Tailscale.");
  const { welcome, stream } = await shake(socket, identity, remoteKey, hello);
  if (welcome.ok && welcome.protocol !== DESKTOP_LINK_PROTOCOL) {
    stream.close();
    throw new Error("The other Mac runs a different version of Lodestar. Update both Macs.");
  }
  if (!welcome.ok) {
    stream.close();
    throw new Error(welcome.error);
  }
  return { welcome, stream, host: reached };
}

export class DesktopLinkClient {
  constructor(private deps: LinkClientDeps) {}

  private async open(remoteId: string, hello: LinkHello) {
    const remote = this.deps.remotes.get(remoteId);
    if (!remote) throw new Error("This Mac is not in the list of Macs you can open");
    const opened = await openLink(this.deps.identity, remote, hello);
    this.deps.remotes.prefer(remote.id, opened.host);
    return opened;
  }

  async check(remoteId: string): Promise<{ name: string; version: string }> {
    const { welcome, stream } = await this.open(remoteId, { v: 1, kind: "ping" });
    stream.close();
    if (!welcome.ok) throw new Error(welcome.error);
    return { name: welcome.name, version: welcome.version };
  }

  bridgeSocket(client: WebSocket, remoteId: string, path: (typeof LINK_WS_PATHS)[number], query: string) {
    const held: { type: number; body: Uint8Array }[] = [];
    let stream: LinkStream | null = null;
    let closed = false;
    client.on("message", (data, isBinary) => {
      const frame = { type: isBinary ? LinkFrame.binary : LinkFrame.text, body: bytesOf(data) };
      if (stream) void stream.send(frame.type, frame.body);
      else held.push(frame);
    });
    client.on("error", () => {});
    client.on("close", () => {
      closed = true;
      stream?.close();
    });
    this.open(remoteId, { v: 1, kind: "ws", path, query: localQuery(query, null).slice(1) }).then(
      (opened) => {
        if (closed) return opened.stream.close();
        stream = opened.stream;
        stream.onClose = () => client.close(1013, "The connection to the other Mac closed");
        stream.onFrame = (type, body) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (type === LinkFrame.text) client.send(decodeText(body));
          else if (type === LinkFrame.binary) client.send(body, { binary: true });
          else if (type === LinkFrame.close) client.close(1013, "The other Mac closed this connection");
        };
        for (const frame of held.splice(0)) void stream.send(frame.type, frame.body);
      },
      (error: Error) => {
        this.deps.log?.(`[link] ${path} to ${remoteId} failed: ${error.message}`);
        if (!closed) client.close(1013, error.message.slice(0, 120));
      },
    );
  }

  async proxyHttp(req: IncomingMessage, res: ServerResponse, remoteId: string, path: (typeof LINK_HTTP_PATHS)[number], query: string): Promise<void> {
    const method = req.method === "POST" ? "POST" : req.method === "HEAD" ? "HEAD" : "GET";
    const headers: Record<string, string> = {};
    for (const name of LINK_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const { stream } = await this.open(remoteId, { v: 1, kind: "http", method, path, query, headers });
    let finished = false;
    stream.onFrame = (type, body) => {
      if (type === LinkFrame.head) {
        const head = parseJson<{ status: number; headers: Record<string, string> }>(body);
        if (!head) return stream.close();
        res.writeHead(head.status, head.headers);
      } else if (type === LinkFrame.body) res.write(body);
      else if (type === LinkFrame.end) {
        finished = true;
        res.end();
      }
    };
    stream.onClose = () => {
      if (finished) return;
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end();
    };
    res.on("close", () => stream.close());
    for await (const chunk of req as AsyncIterable<Buffer>) {
      for (let at = 0; at < chunk.length; at += BODY_CHUNK_BYTES) await stream.send(LinkFrame.body, chunk.subarray(at, at + BODY_CHUNK_BYTES));
    }
    await stream.send(LinkFrame.end);
  }
}
