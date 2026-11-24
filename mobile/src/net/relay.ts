import type { PairResult } from "@shared/mobile";
import { decodeText, encodeText, fromBase64Url, RelayAssembler, relayFrame, RelayFrame, relayParts, RELAY_CHUNK_BYTES, RELAY_UPLOAD_WINDOW_BYTES, relayPrologue, startInitiator, toHex, type RelayHello, type RelayHttpResponse, type RelaySession, type RelayWelcome } from "./relayNoise.generated";
import { phoneNoise, secureRandomBytes } from "./relayCrypto";

export type RelayTarget = { url: string; id: string; key: string };
export type RelayEndpoint = RelayTarget & { privateKey: string };

type RawSocket = {
  binaryType: string;
  readyState: number;
  send(data: ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type RelaySocketFactory = (url: string) => RawSocket;

const defaultFactory: RelaySocketFactory = (url) => new (globalThis as unknown as { WebSocket: new (url: string) => RawSocket }).WebSocket(url);

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const toBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export function relayHost(target: RelayTarget) {
  return target.url.replace(/^https?:\/\//, "");
}

function relayClientUrl(target: RelayTarget) {
  return `${target.url.replace(/^http/, "ws")}/v1/client/${target.id}`;
}

export function createRelayKey(): string {
  return toHex(secureRandomBytes(32));
}

type ChannelHandlers = {
  welcome: (welcome: RelayWelcome) => void;
  message: (plaintext: Uint8Array) => void;
  closed: (code: number, reason: string) => void;
};

class RelayChannel {
  private socket: RawSocket;
  private session: RelaySession | null = null;
  private finished = false;

  constructor(target: RelayEndpoint, hello: RelayHello, private handlers: ChannelHandlers, factory: RelaySocketFactory = defaultFactory) {
    const remoteStatic = fromBase64Url(target.key);
    if (!remoteStatic || remoteStatic.length !== 32) throw new Error("The relay key in this pairing is not valid");
    const initiator = startInitiator(phoneNoise, { staticPrivate: hexBytes(target.privateKey), remoteStatic, prologue: relayPrologue(target.id) });
    const socket = factory(relayClientUrl(target));
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      try {
        socket.send(toBuffer(initiator.writeFirst(encodeText(JSON.stringify(hello)))));
      } catch {
        this.finish(4400, "could not start");
      }
    };
    socket.onmessage = (event) => {
      if (this.finished || !(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      try {
        if (!this.session) {
          const { payload, session } = initiator.readSecond(bytes);
          this.session = session;
          return this.handlers.welcome(JSON.parse(decodeText(payload)) as RelayWelcome);
        }
        this.handlers.message(this.session.open(bytes));
      } catch {
        this.finish(4400, "bad frame");
      }
    };
    socket.onerror = () => {};
    socket.onclose = (event) => this.finish(event.code ?? 1006, event.reason ?? "");
  }

  send(plaintext: Uint8Array) {
    if (!this.session || this.finished) throw new Error("Not connected to your Mac");
    this.socket.send(toBuffer(this.session.seal(plaintext)));
  }

  close(code = 1000, reason = "") {
    if (this.finished) return;
    this.finished = true;
    this.detach();
    try {
      this.socket.close(code === 1000 ? 1000 : undefined, reason);
    } catch {
      return;
    }
  }

  finish(code: number, reason: string) {
    if (this.finished) return;
    this.finished = true;
    this.detach();
    try {
      this.socket.close();
    } catch {
      this.handlers.closed(code, reason);
      return;
    }
    this.handlers.closed(code, reason);
  }

  private detach() {
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onclose = null;
    this.socket.onerror = null;
  }
}

export class RelaySocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private channel: RelayChannel;
  private parts: RelayAssembler | null = null;

  constructor(target: RelayEndpoint, factory?: RelaySocketFactory) {
    this.channel = new RelayChannel(target, { v: 1, kind: "ws", parts: true }, {
      welcome: (welcome) => {
        if (!welcome.ok) return this.channel.finish(welcome.error === "bad token" ? 4401 : 4403, welcome.error);
        if (welcome.parts === true) this.parts = new RelayAssembler();
        this.readyState = 1;
        this.onopen?.({});
      },
      message: (plaintext) => {
        const message = this.parts ? this.parts.push(plaintext) : plaintext;
        if (message) this.onmessage?.({ data: decodeText(message) });
      },
      closed: (code, reason) => {
        this.readyState = 3;
        this.onclose?.({ code, reason });
      },
    }, factory);
  }

  send(data: string) {
    const message = encodeText(data);
    if (!this.parts) return this.channel.send(message);
    for (const part of relayParts(message)) this.channel.send(part);
  }

  close() {
    this.readyState = 3;
    this.channel.close();
  }
}

export type RelayPairOutcome = { ok: true; result: PairResult; privateKey: string } | { ok: false; reason: "rejected" | "unreachable"; message: string };

export function pairOverRelay(target: RelayTarget, code: string, deviceName: string, opts: { timeoutMs?: number; factory?: RelaySocketFactory } = {}): Promise<RelayPairOutcome> {
  const privateKey = createRelayKey();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: RelayPairOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.close();
      resolve(outcome);
    };
    const unreachable = "Could not reach your Mac through the relay. Check that Connect from anywhere is on in Lodestar Settings on your Mac.";
    const channel = new RelayChannel({ ...target, privateKey }, { v: 1, kind: "pair", code, deviceName }, {
      welcome: (welcome) => {
        if (welcome.ok && typeof welcome.deviceToken === "string" && typeof welcome.deviceId === "string") {
          return settle({ ok: true, privateKey, result: { deviceId: welcome.deviceId, deviceToken: welcome.deviceToken, host: welcome.host ?? "Mac", protocol: welcome.protocol ?? 1 } });
        }
        settle({ ok: false, reason: "rejected", message: welcome.ok ? "Your Mac did not finish pairing" : welcome.error });
      },
      message: () => {},
      closed: (closeCode) => settle({ ok: false, reason: "unreachable", message: closeCode === 4404 ? "Your Mac is not connected to the relay. Check that it is awake and Connect from anywhere is on." : unreachable }),
    }, opts.factory);
    const timer = setTimeout(() => settle({ ok: false, reason: "unreachable", message: unreachable }), opts.timeoutMs ?? 15_000);
  });
}

export type RelayUploadOptions = { onProgress?: (fraction: number) => void; onHead?: (head: RelayHttpResponse) => void; onBody?: (chunk: Uint8Array) => void; idleTimeoutMs?: number; signal?: AbortSignal; timeoutMs?: number; factory?: RelaySocketFactory; unackedBytesPerSecond?: number };

export type RelayBodySource = { size: number; read(from: number, to: number): Promise<Uint8Array> };

const UNACKED_BYTES_PER_SECOND = 1024 * 1024;

const bytesSource = (bytes: Uint8Array): RelayBodySource => ({ size: bytes.length, read: async (from, to) => bytes.subarray(from, to) });
const isBodySource = (body: Uint8Array | RelayBodySource): body is RelayBodySource => !(body instanceof Uint8Array);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function relayHttp(target: RelayEndpoint, request: { method: "GET" | "POST"; path: string; headers: Record<string, string>; body?: Uint8Array | RelayBodySource }, opts: RelayUploadOptions = {}): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    let head: RelayHttpResponse | null = null;
    const chunks: Uint8Array[] = [];
    let done = false;
    let acked = 0;
    let wakeSender: (() => void) | null = null;
    const wake = () => {
      const resume = wakeSender;
      wakeSender = null;
      resume?.();
    };
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wake();
      channel.close();
      if (error) return reject(error);
      const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const body = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
      resolve({ status: head?.status ?? 502, headers: head?.headers ?? {}, body });
    };
    const source = request.body === undefined ? bytesSource(new Uint8Array(0)) : isBodySource(request.body) ? request.body : bytesSource(request.body);
    const roomFor = async (sent: number) => {
      while (!done && sent - acked >= RELAY_UPLOAD_WINDOW_BYTES) await new Promise<void>((resume) => (wakeSender = resume));
    };
    const sendBody = async (acks: boolean) => {
      const started = Date.now();
      const pace = opts.unackedBytesPerSecond ?? UNACKED_BYTES_PER_SECOND;
      for (let at = 0; at < source.size; ) {
        const block = await source.read(at, Math.min(source.size, at + RELAY_UPLOAD_WINDOW_BYTES));
        if (done) return;
        if (block.length === 0) throw new Error("Could not read the file");
        for (let offset = 0; offset < block.length; offset += RELAY_CHUNK_BYTES) {
          const sent = at + offset;
          if (acks) await roomFor(sent);
          else await wait(Math.max(0, (sent / pace) * 1000 - (Date.now() - started)));
          if (done) return;
          channel.send(relayFrame(RelayFrame.body, block.subarray(offset, offset + RELAY_CHUNK_BYTES)));
          if (!acks) opts.onProgress?.(Math.min(1, (sent + RELAY_CHUNK_BYTES) / Math.max(1, source.size)));
        }
        at += block.length;
      }
      channel.send(relayFrame(RelayFrame.end, new Uint8Array(0)));
    };
    const channel = new RelayChannel(target, { v: 1, kind: "http" }, {
      welcome: (welcome) => {
        if (!welcome.ok) return finish(new Error(welcome.error === "bad token" ? "This phone was removed from your Mac" : welcome.error));
        try {
          channel.send(relayFrame(RelayFrame.head, encodeText(JSON.stringify({ method: request.method, path: request.path, headers: request.headers }))));
        } catch (error) {
          return finish(error instanceof Error ? error : new Error(String(error)));
        }
        sendBody(welcome.acks === true).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      },
      message: (frame) => {
        const type = frame[0];
        if (opts.idleTimeoutMs) {
          clearTimeout(timer);
          timer = setTimeout(() => finish(new Error("Your Mac stopped answering")), opts.idleTimeoutMs);
        }
        if (type === RelayFrame.ack) {
          acked = Math.max(acked, Number(decodeText(frame.subarray(1))) || 0);
          opts.onProgress?.(Math.min(1, acked / Math.max(1, source.size)));
          wake();
        } else if (type === RelayFrame.head) {
          head = JSON.parse(decodeText(frame.subarray(1))) as RelayHttpResponse;
          opts.onHead?.(head);
        } else if (type === RelayFrame.body) {
          if (opts.onBody) opts.onBody(frame.subarray(1));
          else chunks.push(frame.slice(1));
        } else if (type === RelayFrame.end) finish(null);
      },
      closed: () => finish(head ? null : new Error("Could not reach your Mac through the relay")),
    }, opts.factory);
    let timer = setTimeout(() => finish(new Error(opts.idleTimeoutMs ? "Your Mac stopped answering" : "The upload took too long")), opts.idleTimeoutMs ?? opts.timeoutMs ?? 60_000);
    opts.signal?.addEventListener("abort", () => finish(new Error("Upload cancelled")));
  });
}
