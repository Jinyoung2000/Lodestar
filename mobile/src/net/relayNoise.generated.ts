export type NoisePrimitives = {
  publicKey(privateKey: Uint8Array): Uint8Array;
  dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
};

export const RELAY_PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
export const RELAY_KEY_BYTES = 32;
const TAG_BYTES = 16;
const EMPTY = new Uint8Array(0);
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const encodeText = (text: string) => utf8.encode(text);
export const decodeText = (bytes: Uint8Array) => fromUtf8.decode(bytes);

function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  let value = counter;
  for (let i = 4; i < 12; i++) {
    nonce[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return nonce;
}

function hkdf(p: NoisePrimitives, chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = p.hmacSha256(chainingKey, input);
  const first = p.hmacSha256(temp, Uint8Array.of(1));
  const second = p.hmacSha256(temp, concatBytes(first, Uint8Array.of(2)));
  return [first, second];
}

function checkedDh(p: NoisePrimitives, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== RELAY_KEY_BYTES) throw new Error("bad public key");
  const shared = p.dh(privateKey, publicKey);
  if (shared.every((byte) => byte === 0)) throw new Error("bad public key");
  return shared;
}

class SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
  private key: Uint8Array | null = null;
  private counter = 0;

  constructor(private p: NoisePrimitives, prologue: Uint8Array) {
    const name = encodeText(RELAY_PROTOCOL_NAME);
    this.hash = name.length <= 32 ? concatBytes(name, new Uint8Array(32 - name.length)) : p.sha256(name);
    this.chainingKey = this.hash;
    this.mixHash(prologue);
  }

  mixHash(data: Uint8Array) {
    this.hash = this.p.sha256(concatBytes(this.hash, data));
  }

  mixKey(input: Uint8Array) {
    const [chainingKey, key] = hkdf(this.p, this.chainingKey, input);
    this.chainingKey = chainingKey;
    this.key = key;
    this.counter = 0;
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.key ? this.p.seal(this.key, nonceFor(this.counter++), this.hash, plaintext) : plaintext;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.key ? this.p.open(this.key, nonceFor(this.counter++), this.hash, ciphertext) : ciphertext;
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [Uint8Array, Uint8Array] {
    return hkdf(this.p, this.chainingKey, EMPTY);
  }
}

export class RelaySession {
  private sent = 0;
  private received = 0;

  constructor(private p: NoisePrimitives, private sendKey: Uint8Array, private receiveKey: Uint8Array, readonly handshakeHash: Uint8Array) {}

  seal(plaintext: Uint8Array): Uint8Array {
    return this.p.seal(this.sendKey, nonceFor(this.sent++), EMPTY, plaintext);
  }

  open(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.p.open(this.receiveKey, nonceFor(this.received), EMPTY, ciphertext);
    this.received++;
    return plaintext;
  }

  get sentCount(): number {
    return this.sent;
  }

  get receivedCount(): number {
    return this.received;
  }
}

export class RelayResendLog {
  private frames: Uint8Array[] = [];
  private first = 0;
  private bytes = 0;

  constructor(private maxFrames: number, private maxBytes: number) {}

  add(sealed: Uint8Array) {
    this.frames.push(sealed);
    this.bytes += sealed.length;
    while (this.frames.length > this.maxFrames || this.bytes > this.maxBytes) {
      this.bytes -= (this.frames.shift() as Uint8Array).length;
      this.first++;
    }
  }

  from(index: unknown): Uint8Array[] | null {
    if (typeof index !== "number" || !Number.isInteger(index) || index < this.first || index > this.first + this.frames.length) return null;
    return this.frames.slice(index - this.first);
  }
}

export type RelayResume = { t: "resume"; rx: number };

export function parseRelayResume(text: string): RelayResume | null {
  if (text.length > 64) return null;
  try {
    const message = JSON.parse(text) as { t?: unknown; rx?: unknown };
    return message.t === "resume" && typeof message.rx === "number" && Number.isInteger(message.rx) && message.rx >= 0 ? { t: "resume", rx: message.rx } : null;
  } catch {
    return null;
  }
}

export type HandshakeKeys = { staticPrivate: Uint8Array; ephemeralPrivate?: Uint8Array; prologue: Uint8Array };

export function startInitiator(p: NoisePrimitives, keys: HandshakeKeys & { remoteStatic: Uint8Array }) {
  const state = new SymmetricState(p, keys.prologue);
  state.mixHash(keys.remoteStatic);
  const ephemeral = keys.ephemeralPrivate ?? p.randomBytes(RELAY_KEY_BYTES);
  return {
    writeFirst(payload: Uint8Array): Uint8Array {
      const ephemeralPublic = p.publicKey(ephemeral);
      state.mixHash(ephemeralPublic);
      state.mixKey(checkedDh(p, ephemeral, keys.remoteStatic));
      const sealedStatic = state.encryptAndHash(p.publicKey(keys.staticPrivate));
      state.mixKey(checkedDh(p, keys.staticPrivate, keys.remoteStatic));
      return concatBytes(ephemeralPublic, sealedStatic, state.encryptAndHash(payload));
    },
    readSecond(message: Uint8Array): { payload: Uint8Array; session: RelaySession } {
      if (message.length < RELAY_KEY_BYTES + TAG_BYTES) throw new Error("short handshake");
      const remoteEphemeral = message.subarray(0, RELAY_KEY_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(checkedDh(p, ephemeral, remoteEphemeral));
      state.mixKey(checkedDh(p, keys.staticPrivate, remoteEphemeral));
      const payload = state.decryptAndHash(message.subarray(RELAY_KEY_BYTES));
      const [toResponder, toInitiator] = state.split();
      return { payload, session: new RelaySession(p, toResponder, toInitiator, state.hash) };
    },
  };
}

export function startResponder(p: NoisePrimitives, keys: HandshakeKeys) {
  const state = new SymmetricState(p, keys.prologue);
  state.mixHash(p.publicKey(keys.staticPrivate));
  let remoteEphemeral: Uint8Array | null = null;
  let remoteStatic: Uint8Array | null = null;
  return {
    readFirst(message: Uint8Array): { remoteStatic: Uint8Array; payload: Uint8Array } {
      if (message.length < RELAY_KEY_BYTES * 2 + TAG_BYTES * 2) throw new Error("short handshake");
      remoteEphemeral = message.slice(0, RELAY_KEY_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(checkedDh(p, keys.staticPrivate, remoteEphemeral));
      const staticEnd = RELAY_KEY_BYTES * 2 + TAG_BYTES;
      remoteStatic = state.decryptAndHash(message.subarray(RELAY_KEY_BYTES, staticEnd));
      state.mixKey(checkedDh(p, keys.staticPrivate, remoteStatic));
      return { remoteStatic, payload: state.decryptAndHash(message.subarray(staticEnd)) };
    },
    writeSecond(payload: Uint8Array): { message: Uint8Array; session: RelaySession } {
      if (!remoteEphemeral || !remoteStatic) throw new Error("handshake out of order");
      const ephemeral = keys.ephemeralPrivate ?? p.randomBytes(RELAY_KEY_BYTES);
      const ephemeralPublic = p.publicKey(ephemeral);
      state.mixHash(ephemeralPublic);
      state.mixKey(checkedDh(p, ephemeral, remoteEphemeral));
      state.mixKey(checkedDh(p, ephemeral, remoteStatic));
      const message = concatBytes(ephemeralPublic, state.encryptAndHash(payload));
      const [toResponder, toInitiator] = state.split();
      return { message, session: new RelaySession(p, toInitiator, toResponder, state.hash) };
    },
  };
}

export const RELAY_ID_RE = /^[0-9a-f]{32}$/;

export function relayPrologue(relayId: string): Uint8Array {
  return encodeText(`lodestar-relay-v1:${relayId}`);
}

export type RelayStreamKind = "ws" | "http" | "pair";
export type RelayHello = { v: 1; kind: "ws" | "http"; parts?: true; resume?: true } | { v: 1; kind: "pair"; code: string; deviceName: string };
export type RelayWelcome = { ok: true; parts?: true; acks?: true; resume?: true; deviceId?: string; deviceToken?: string; host?: string; protocol?: number } | { ok: false; error: string };

export const RelayFrame = { head: 1, body: 2, end: 3, ack: 4 } as const;

export const RELAY_UPLOAD_WINDOW_BYTES = 1024 * 1024;

export function relayFrame(type: number, body: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(type), body);
}

export type RelayHttpRequest = { method: "GET" | "POST"; path: string; headers: Record<string, string> };
export type RelayHttpResponse = { status: number; headers: Record<string, string> };

export const RELAY_CHUNK_BYTES = 192 * 1024;
export const RELAY_MESSAGE_BYTES = 64 * 1024 * 1024;

export const RelayPart = { more: 1, last: 2 } as const;

export function relayParts(message: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let at = 0; at === 0 || at < message.length; at += RELAY_CHUNK_BYTES) {
    const end = at + RELAY_CHUNK_BYTES;
    parts.push(relayFrame(end < message.length ? RelayPart.more : RelayPart.last, message.subarray(at, end)));
  }
  return parts;
}

export class RelayAssembler {
  private held: Uint8Array[] = [];
  private size = 0;

  push(frame: Uint8Array): Uint8Array | null {
    const type = frame[0];
    if (type !== RelayPart.more && type !== RelayPart.last) throw new Error("bad part");
    this.size += frame.length - 1;
    if (this.size > RELAY_MESSAGE_BYTES) throw new Error("message too large");
    this.held.push(frame.subarray(1));
    if (type === RelayPart.more) return null;
    const whole = this.held.length === 1 ? this.held[0] : concatBytes(...this.held);
    this.held = [];
    this.size = 0;
    return whole;
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [B64[(n >> 18) & 63], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]];
    out += chars.slice(0, Math.min(4, bytes.length - i + 1)).join("");
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
