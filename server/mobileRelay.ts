import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname } from "node:path";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { WebSocket } from "ws";
import { MAX_IMAGE_BYTES } from "../shared/images";
import type { MobileRelayLinkState, MobileRelayPairing } from "../shared/mobile";
import { decodeText, encodeText, relayFrame, RelayFrame, RELAY_CHUNK_BYTES, RELAY_ID_RE, relayPrologue, startResponder, toBase64Url, toHex, type NoisePrimitives, type RelayHello, type RelayHttpRequest, type RelaySession, type RelayWelcome } from "../shared/relayNoise";
import type { MobileDevices, PairOutcome } from "./mobileAccess";
import { T } from "./strings";

export const nodeNoise: NoisePrimitives = {
  publicKey: (privateKey) => x25519.getPublicKey(privateKey),
  dh: (privateKey, publicKey) => x25519.getSharedSecret(privateKey, publicKey),
  randomBytes: (length) => new Uint8Array(randomBytes(length)),
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  seal: (key, nonce, ad, plaintext) => chacha20poly1305(key, nonce, ad).encrypt(plaintext),
  open: (key, nonce, ad, ciphertext) => chacha20poly1305(key, nonce, ad).decrypt(ciphertext),
};

type IdentityFile = { id: string; secret: string; privateKey: string };
export type RelayIdentity = { id: string; secret: string; privateKey: Uint8Array; publicKey: Uint8Array };

export function loadRelayIdentity(file: string): RelayIdentity {
  let stored: IdentityFile | null = null;
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<IdentityFile>;
    if (typeof parsed.id === "string" && RELAY_ID_RE.test(parsed.id) && typeof parsed.secret === "string" && /^[0-9a-f]{64}$/.test(parsed.secret) && typeof parsed.privateKey === "string" && /^[0-9a-f]{64}$/.test(parsed.privateKey)) stored = parsed as IdentityFile;
  }
  if (!stored) {
    stored = { id: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("hex"), privateKey: randomBytes(32).toString("hex") };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(stored, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  const privateKey = Uint8Array.from(Buffer.from(stored.privateKey, "hex"));
  return { id: stored.id, secret: stored.secret, privateKey, publicKey: nodeNoise.publicKey(privateKey) };
}

export function normalizeRelayUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.protocol === "http:" && !/^(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export type RelayLinkDeps = {
  url: string;
  identity: RelayIdentity;
  devices: MobileDevices;
  pair: (code: unknown, deviceName: unknown, relayKey: string) => PairOutcome;
  local: () => { host: string; port: number } | null;
  bridgeKey: string;
  log?: (line: string) => void;
  noise?: NoisePrimitives;
};

const HANDSHAKE_TIMEOUT_MS = 10_000;
const KEEPALIVE_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_CHANNELS = 32;
const HTTP_PATHS: Record<string, RelayHttpRequest["method"]> = { "/mobile/images": "POST", "/mobile/media": "GET" };
const PASS_REQUEST_HEADERS = ["authorization", "content-type", "x-image-name", "range"];
const PASS_RESPONSE_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];

export class RelayLink {
  state: MobileRelayLinkState = { state: "off", error: null };
  private socket: WebSocket | null = null;
  private channels = new Map<number, RelayChannel>();
  private retry: NodeJS.Timeout | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private running = false;

  constructor(private deps: RelayLinkDeps) {}

  get pairing(): MobileRelayPairing {
    return { url: this.deps.url, id: this.deps.identity.id, key: toBase64Url(this.deps.identity.publicKey) };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.dropSocket();
    this.state = { state: "off", error: null };
  }

  closeDevice(deviceId: string) {
    for (const channel of this.channels.values()) if (channel.deviceId === deviceId) channel.close(4001, "device removed");
  }

  private connect() {
    if (!this.running) return;
    this.state = { state: "connecting", error: this.state.error };
    const url = `${this.deps.url.replace(/^http/, "ws")}/v1/host/${this.deps.identity.id}`;
    const socket = new WebSocket(url, { headers: { "x-relay-secret": this.deps.identity.secret }, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 15_000 });
    this.socket = socket;
    socket.binaryType = "nodebuffer";
    socket.on("open", () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.state = { state: "online", error: null };
      this.deps.log?.("[relay] connected");
      this.keepalive = setInterval(() => this.ping(socket), KEEPALIVE_MS);
      this.keepalive.unref();
    });
    socket.on("unexpected-response", (_req, res) => {
      if (socket !== this.socket) return;
      this.fail(res.statusCode === 401 ? "The relay did not accept this Mac" : `The relay answered ${res.statusCode}`);
      socket.terminate();
    });
    socket.on("message", (data, isBinary) => {
      if (socket !== this.socket) return;
      if (!isBinary) return this.control(data.toString());
      const buffer = data as Buffer;
      if (buffer.length < 4) return;
      this.channels.get(buffer.readUInt32BE(0))?.receive(new Uint8Array(buffer.subarray(4)));
    });
    socket.on("error", (error) => {
      if (socket === this.socket) this.state = { state: "connecting", error: relayErrorText(error) };
    });
    socket.on("close", () => {
      if (socket !== this.socket) return;
      this.dropSocket();
      this.scheduleRetry();
    });
  }

  private fail(message: string) {
    this.state = { state: "error", error: message };
    this.deps.log?.(`[relay] ${message}`);
  }

  private scheduleRetry() {
    if (!this.running || this.retry) return;
    if (this.state.state !== "error") this.state = { state: "connecting", error: this.state.error ?? "Reconnecting" };
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6)) + Math.floor(Math.random() * 1000);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
    this.retry.unref();
  }

  private dropSocket() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    for (const channel of this.channels.values()) channel.dispose();
    this.channels.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners("message");
      socket.on("error", () => {});
      try {
        socket.terminate();
      } catch {
        return;
      }
    }
  }

  private ping(socket: WebSocket) {
    if (socket.readyState !== socket.OPEN || this.pongTimer) return;
    socket.send("ping");
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (socket !== this.socket) return;
      this.deps.log?.("[relay] no answer from the relay, reconnecting");
      this.dropSocket();
      this.scheduleRetry();
    }, PONG_TIMEOUT_MS);
    this.pongTimer.unref();
  }

  private control(text: string) {
    if (text === "pong") {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    let message: { t?: unknown; c?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.c !== "number") return;
    const id = message.c;
    if (message.t === "open") {
      if (this.channels.size >= MAX_CHANNELS) return this.closeChannel(id, 4429, "too many connections");
      this.channels.set(id, new RelayChannel(id, this, this.deps));
    } else if (message.t === "close") {
      this.channels.get(id)?.dispose();
      this.channels.delete(id);
    }
  }

  send(id: number, payload: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.closeChannel(id, 4413, "too slow");
      return false;
    }
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(id, 0);
    frame.set(payload, 4);
    socket.send(frame);
    return true;
  }

  buffered(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  closeChannel(id: number, code = 1000, reason = "") {
    this.channels.get(id)?.dispose();
    this.channels.delete(id);
    const socket = this.socket;
    if (socket?.readyState === socket?.OPEN) socket?.send(JSON.stringify({ t: "close", c: id, code, reason }));
  }
}

class RelayChannel {
  deviceId: string | null = null;
  private responder;
  private session: RelaySession | null = null;
  private mode: "handshake" | "ws" | "http" | "done" = "handshake";
  private local: WebSocket | null = null;
  private queued: string[] = [];
  private httpHead: RelayHttpRequest | null = null;
  private httpBody: Uint8Array[] = [];
  private httpSize = 0;
  private timer: NodeJS.Timeout;
  private noise: NoisePrimitives;

  constructor(private id: number, private link: RelayLink, private deps: RelayLinkDeps) {
    this.noise = deps.noise ?? nodeNoise;
    this.responder = startResponder(this.noise, { staticPrivate: deps.identity.privateKey, prologue: relayPrologue(deps.identity.id) });
    this.timer = setTimeout(() => this.close(4408, "handshake timeout"), HANDSHAKE_TIMEOUT_MS);
    this.timer.unref();
  }

  receive(frame: Uint8Array) {
    try {
      if (this.mode === "handshake") return this.handshake(frame);
      if (!this.session || this.mode === "done") return;
      const plaintext = this.session.open(frame);
      if (this.mode === "ws") return this.toLocalSocket(decodeText(plaintext));
      if (this.mode === "http") return this.httpFrame(plaintext);
    } catch (error) {
      this.deps.log?.(`[relay] channel rejected: ${error instanceof Error ? error.message : String(error)}`);
      this.close(4400, "bad frame");
    }
  }

  private handshake(frame: Uint8Array) {
    const { remoteStatic, payload } = this.responder.readFirst(frame);
    clearTimeout(this.timer);
    const hello = JSON.parse(decodeText(payload)) as RelayHello;
    const relayKey = toHex(remoteStatic);
    if (hello.v !== 1) return this.welcome({ ok: false, error: "Update Lodestar on your Mac" }, true);
    if (hello.kind === "pair") {
      const outcome = this.deps.pair(hello.code, hello.deviceName, relayKey);
      return this.welcome(outcome.ok ? { ok: true, ...outcome.result } : { ok: false, error: outcome.error }, true);
    }
    const device = this.deps.devices.byRelayKey(relayKey);
    if (!device) return this.welcome({ ok: false, error: "bad token" }, true);
    this.deviceId = device.id;
    if (hello.kind === "ws") {
      this.mode = "ws";
      this.welcome({ ok: true });
      return this.openLocalSocket();
    }
    if (hello.kind === "http") {
      this.mode = "http";
      return this.welcome({ ok: true });
    }
    this.welcome({ ok: false, error: "Unknown request" }, true);
  }

  private welcome(message: RelayWelcome, thenClose = false) {
    const { message: reply, session } = this.responder.writeSecond(encodeText(JSON.stringify(message)));
    this.session = session;
    this.link.send(this.id, reply);
    if (thenClose) this.close(1000, message.ok ? "" : message.error.slice(0, 100));
  }

  private sendSealed(plaintext: Uint8Array) {
    if (!this.session || this.mode === "done") return false;
    return this.link.send(this.id, this.session.seal(plaintext));
  }

  private openLocalSocket() {
    const target = this.deps.local();
    if (!target) return this.close(4404, "mac offline");
    const socket = new WebSocket(`ws://${target.host}:${target.port}/mobile/ws`, { maxPayload: 2 * 1024 * 1024, headers: { "x-lodestar-relay-bridge": this.deps.bridgeKey } });
    this.local = socket;
    socket.on("open", () => {
      for (const text of this.queued) socket.send(text);
      this.queued = [];
    });
    socket.on("message", (data) => {
      this.sendSealed(encodeText(data.toString()));
    });
    socket.on("error", () => {});
    socket.on("close", (code, reason) => {
      if (this.local !== socket) return;
      this.local = null;
      this.close(code >= 4000 && code <= 4999 ? code : 1000, reason.toString());
    });
  }

  private toLocalSocket(text: string) {
    const socket = this.local;
    if (!socket) return;
    if (socket.readyState === socket.OPEN) socket.send(text);
    else if (socket.readyState === socket.CONNECTING && this.queued.length < 64) this.queued.push(text);
  }

  private httpFrame(frame: Uint8Array) {
    const type = frame[0];
    const body = frame.subarray(1);
    if (type === RelayFrame.head && !this.httpHead) {
      const head = JSON.parse(decodeText(body)) as RelayHttpRequest;
      const path = typeof head.path === "string" ? head.path : "";
      const pathname = path.split("?")[0];
      if (HTTP_PATHS[pathname] !== head.method || !path.startsWith("/")) return this.respond(404, { error: "not found" });
      this.httpHead = { method: head.method, path, headers: head.headers ?? {} };
      return;
    }
    if (type === RelayFrame.body && this.httpHead) {
      this.httpSize += body.length;
      if (this.httpSize > MAX_IMAGE_BYTES) return this.respond(413, { error: T.errMobileImageTooLarge(MAX_IMAGE_BYTES / 1024 / 1024) });
      this.httpBody.push(body.slice());
      return;
    }
    if (type === RelayFrame.end && this.httpHead) return this.forwardHttp(this.httpHead);
    this.close(4400, "bad frame");
  }

  private respond(status: number, body: unknown) {
    const bytes = encodeText(JSON.stringify(body));
    this.sendSealed(relayFrame(RelayFrame.head, encodeText(JSON.stringify({ status, headers: { "content-type": "application/json; charset=utf-8" } }))));
    this.sendSealed(relayFrame(RelayFrame.body, bytes));
    this.sendSealed(relayFrame(RelayFrame.end, new Uint8Array(0)));
    this.close();
  }

  private forwardHttp(head: RelayHttpRequest) {
    const target = this.deps.local();
    if (!target) return this.respond(503, { error: "Mobile access is off" });
    const headers: Record<string, string> = {};
    for (const name of PASS_REQUEST_HEADERS) {
      const value = Object.entries(head.headers).find(([key]) => key.toLowerCase() === name)?.[1];
      if (typeof value === "string") headers[name] = value;
    }
    const body = Buffer.concat(this.httpBody);
    this.httpBody = [];
    if (head.method === "POST") headers["content-length"] = String(body.length);
    const req = httpRequest({ host: target.host, port: target.port, method: head.method, path: head.path, headers }, (res) => {
      const responseHeaders: Record<string, string> = {};
      for (const name of PASS_RESPONSE_HEADERS) {
        const value = res.headers[name];
        if (typeof value === "string") responseHeaders[name] = value;
      }
      this.sendSealed(relayFrame(RelayFrame.head, encodeText(JSON.stringify({ status: res.statusCode ?? 502, headers: responseHeaders }))));
      res.on("data", (chunk: Buffer) => {
        for (let at = 0; at < chunk.length; at += RELAY_CHUNK_BYTES) this.sendSealed(relayFrame(RelayFrame.body, new Uint8Array(chunk.subarray(at, at + RELAY_CHUNK_BYTES))));
        if (this.link.buffered() > MAX_BUFFERED_BYTES / 2) {
          res.pause();
          const wait = setInterval(() => {
            if (this.mode === "done" || this.link.buffered() <= MAX_BUFFERED_BYTES / 4) {
              clearInterval(wait);
              res.resume();
            }
          }, 50);
        }
      });
      res.on("end", () => {
        this.sendSealed(relayFrame(RelayFrame.end, new Uint8Array(0)));
        this.close();
      });
      res.on("error", () => this.close(4500, "local error"));
    });
    req.on("error", () => this.respond(502, { error: "Could not reach Mobile access on this Mac" }));
    req.end(head.method === "POST" ? body : undefined);
  }

  close(code = 1000, reason = "") {
    if (this.mode === "done") return;
    this.link.closeChannel(this.id, code, reason);
  }

  dispose() {
    clearTimeout(this.timer);
    this.mode = "done";
    const local = this.local;
    this.local = null;
    this.queued = [];
    this.httpBody = [];
    if (local) {
      local.removeAllListeners("close");
      local.close();
    }
  }
}

export const RELAY_URL_DEFAULT = "https://lodestar-relay.lodestar-app.workers.dev";

function relayErrorText(error: Error & { code?: string }): string {
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN" || error.code === "ENETUNREACH") return "no internet connection";
  if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") return "the relay is not answering";
  if (error.code === "ETIMEDOUT" || /timed out/i.test(error.message)) return "the relay took too long to answer";
  return error.message;
}
