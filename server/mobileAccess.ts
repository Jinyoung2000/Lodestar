// 모바일 포트는 JSON 몇 개와 WebSocket 하나, 이미지 업로드 하나만 받는다. 메인 토큰은 이 서버에서 통하지 않고, 장치마다 다른 장치 토큰만 통한다.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildManualPairing, buildPairingUri, MOBILE_EVENT_TYPES, MOBILE_MEDIA_PATH, MOBILE_METHODS, MOBILE_PROTOCOL, compactTimelineItem, mobileModelId, pairingCodeLabel, type MobileDevice, type MobileHost, type MobileModelSelection, type MobileReady, type MobileRelayPairing, type MobileRoute, type PairingOffer, type PairResult } from "../shared/mobile";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "../shared/images";
import { HARNESS_VALUES, isEffortLevel, type Agent, type Harness, type ServerEvent } from "../shared/protocol";
import { resolveAddable, resolveFolder } from "./mobileFolders";
import { T } from "./strings";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_FAILURES = 5;

export type RedeemResult = "ok" | "invalid" | "expired" | "locked";
export type PairOutcome = { ok: true; result: PairResult } | { ok: false; status: number; error: string };

export class PairingCodes {
  private current: { code: string; expiresAt: number; failures: number } | null = null;

  constructor(private opts: { ttlMs?: number; maxFailures?: number; now?: () => number } = {}) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  issue(): { code: string; expiresAt: number } {
    const bytes = randomBytes(CODE_LENGTH);
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    this.current = { code, expiresAt: this.now() + (this.opts.ttlMs ?? PAIRING_TTL_MS), failures: 0 };
    return { code, expiresAt: this.current.expiresAt };
  }

  // 코드를 확인하고 쓴다. 맞으면 바로 폐기한다. 사용자가 하이픈이나 공백, 소문자로 적어도 받는다.
  redeem(input: unknown): RedeemResult {
    const current = this.current;
    if (!current) return "invalid";
    if (this.now() > current.expiresAt) {
      this.current = null;
      return "expired";
    }
    const typed = typeof input === "string" ? input.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const a = Buffer.from(typed.padEnd(CODE_LENGTH, "\0").slice(0, CODE_LENGTH));
    const b = Buffer.from(current.code);
    const same = typed.length === CODE_LENGTH && timingSafeEqual(a, b);
    if (same) {
      this.current = null;
      return "ok";
    }
    current.failures += 1;
    if (current.failures >= (this.opts.maxFailures ?? PAIRING_MAX_FAILURES)) {
      this.current = null;
      return "locked";
    }
    return "invalid";
  }

  clear() {
    this.current = null;
  }

  get active() {
    return this.current && this.now() <= this.current.expiresAt ? { expiresAt: this.current.expiresAt } : null;
  }
}

export class AttemptLimiter {
  private times: number[] = [];

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  take(): boolean {
    const cutoff = this.now() - this.windowMs;
    this.times = this.times.filter((t) => t > cutoff);
    if (this.times.length >= this.max) return false;
    this.times.push(this.now());
    return true;
  }
}

type DeviceRecord = { id: string; name: string; tokenHash: string; createdAt: string; lastSeenAt: string | null; relayKey?: string };

const TOKEN_RE = /^[0-9a-f]{64}$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class MobileDevices {
  private records: DeviceRecord[];

  constructor(private file: string) {
    this.records = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DeviceRecord[]) : [];
  }

  list(): DeviceRecord[] {
    return this.records;
  }

  add(rawName: unknown, relayKey?: string): { device: DeviceRecord; token: string } {
    const name = typeof rawName === "string" ? rawName.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "";
    const token = randomBytes(32).toString("hex");
    const device: DeviceRecord = { id: randomUUID(), name: name || "iPhone", tokenHash: sha256(token), createdAt: new Date().toISOString(), lastSeenAt: null, ...(relayKey ? { relayKey } : {}) };
    this.records.push(device);
    this.save();
    return { device, token };
  }

  verify(token: unknown): DeviceRecord | null {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const hash = Buffer.from(sha256(token), "hex");
    let found: DeviceRecord | null = null;
    for (const record of this.records) if (timingSafeEqual(hash, Buffer.from(record.tokenHash, "hex"))) found = record;
    return found;
  }

  byRelayKey(relayKey: string): DeviceRecord | null {
    return this.records.find((record) => record.relayKey === relayKey) ?? null;
  }

  challenge(deviceId: unknown, nonce: unknown) {
    if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) return null;
    const device = this.records.find((record) => record.id === deviceId);
    if (!device) return null;
    const challenge = randomBytes(16).toString("hex");
    const sign = (role: "proof" | "auth") => createHmac("sha256", device.tokenHash).update(`lodestar-route-${role}-v1:${nonce}:${challenge}`).digest("hex");
    return { device, challenge, proof: sign("proof"), auth: sign("auth") };
  }

  touch(id: string) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    record.lastSeenAt = new Date().toISOString();
    this.save();
  }

  revoke(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.records, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

const VIRTUAL_IFACE = /^(utun|awdl|llw|bridge|vmenet|veth|docker|vboxnet|ap\d|gif|stf|anpi|lo)/;

export function lanHosts(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): MobileHost[] {
  const hosts: MobileHost[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal || info.address.startsWith("169.254.")) continue;
      const [a, b] = info.address.split(".").map(Number);
      const tailscale = a === 100 && b >= 64 && b <= 127;
      if (VIRTUAL_IFACE.test(iface) && !tailscale) continue;
      hosts.push({ address: info.address, iface, kind: tailscale ? "tailscale" : "lan" });
    }
  }
  return hosts.sort((x, y) => Number(y.iface === "en0") - Number(x.iface === "en0") || Number(x.kind === "tailscale") - Number(y.kind === "tailscale"));
}

export function makeOffer(issued: { code: string; expiresAt: number }, hosts: MobileHost[], port: number, name: string, relay: MobileRelayPairing | null = null): PairingOffer {
  const first = hosts[0]?.address ?? "127.0.0.1";
  return {
    code: pairingCodeLabel(issued.code),
    expiresAt: issued.expiresAt,
    uri: buildPairingUri({ hosts: hosts.map((h) => h.address), port, code: issued.code, name, relay }),
    manual: buildManualPairing(first, port, issued.code),
    hosts,
    port,
    relay: relay !== null,
  };
}

const METHOD_SET: ReadonlySet<string> = new Set(MOBILE_METHODS);
const ID_LIMIT = 200;
const PROMPT_LIMIT = 50_000;
const THUMB_LIMIT = 30_000;
const UUID_RE = /^[0-9a-f-]{36}$/;
const REF_LIMIT = 200;
const TITLE_LIMIT = 200;

function fail(message: string): never {
  throw new Error(message);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function idOf(value: unknown, name: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT ? value : fail(T.errMobileParam(name));
}

function textOf(value: unknown, name: string, max = PROMPT_LIMIT): string {
  return typeof value === "string" && value.length <= max ? value : fail(T.errMobileParam(name));
}

function imagesOf(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return fail(T.errMobileParam("images"));
  return value.map((raw) => {
    const image = asObject(raw);
    const id = typeof image.id === "string" && UUID_RE.test(image.id) ? image.id : fail(T.errMobileParam("images"));
    const label = typeof image.label === "string" ? image.label.slice(0, 120) : "image";
    const thumb = typeof image.thumb === "string" && image.thumb.length <= THUMB_LIMIT ? image.thumb : fail(T.errMobileParam("images"));
    return { id, label, thumb };
  });
}

function refOf(value: unknown, name: string): string {
  const text = typeof value === "string" ? value : "";
  return text.length > 0 && text.length <= REF_LIMIT && !text.startsWith("-") && !/[\s\u0000-\u001f\u007f]/.test(text) ? text : fail(T.errMobileParam(name));
}

function worktreeOf(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const w = asObject(value);
  return { branch: refOf(w.branch, "branch"), base: refOf(w.base, "base") };
}

function harnessOfParam(value: unknown): Harness {
  if (typeof value !== "string" || !HARNESS_VALUES.includes(value as Harness)) fail(T.errMobileParam("provider"));
  return value as Harness;
}

function modelSelectionOf(value: unknown): MobileModelSelection {
  const { harness, model, effort } = asObject(value);
  const provider = harnessOfParam(harness);
  if (model !== null && !mobileModelId(model)) fail(T.errMobileParam("model"));
  if (effort !== null && !isEffortLevel(effort)) fail(T.errMobileParam("effort"));
  return { harness: provider, model, effort };
}

export function guardMobileCall(method: string, raw: unknown, browseRoot?: string): Record<string, unknown> {
  if (!METHOD_SET.has(method)) fail(T.errMobileMethod(method));
  const p = asObject(raw);
  switch (method) {
    case "mobile.ping":
    case "mobile.defaults":
    case "mobile.workspaceIcons":
    case "workspaces.list":
    case "agents.list":
      return {};
    case "models.pins":
      return {};
    case "models.setPin":
      return { harness: harnessOfParam(p.harness), model: mobileModelId(p.model) ? p.model : fail(T.errMobileParam("model")), pinned: typeof p.pinned === "boolean" ? p.pinned : fail(T.errMobileParam("pinned")) };
    case "mobile.models":
      return { ...(p.switchOnly === true ? { switchOnly: true } : {}), ...(p.agentId === undefined ? {} : { agentId: idOf(p.agentId, "agentId") }), ...(p.harness === undefined ? {} : { harness: harnessOfParam(p.harness) }) };
    case "mobile.setModel":
      return { agentId: idOf(p.agentId, "agentId"), selection: modelSelectionOf(p.selection) };
    case "agents.timelinePage": {
      const limit = typeof p.limit === "number" && Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= 200 ? p.limit : fail(T.errMobileParam("limit"));
      return { agentId: idOf(p.agentId, "agentId"), limit, ...(p.beforeId === undefined ? {} : { beforeId: idOf(p.beforeId, "beforeId") }) };
    }
    case "agents.create":
    case "mobile.createSession": {
      const workspaceId = p.workspaceId === null ? null : idOf(p.workspaceId, "workspaceId");
      const worktree = worktreeOf(p.worktree);
      if (worktree && workspaceId === null) fail(T.errMobileParam("worktree"));
      return { workspaceId, prompt: textOf(p.prompt, "prompt"), ...(p.images === undefined ? {} : { images: imagesOf(p.images) }), ...(worktree ? { worktree } : {}), ...(method === "mobile.createSession" ? { selection: modelSelectionOf(p.selection) } : {}) };
    }
    case "agents.send":
      return { agentId: idOf(p.agentId, "agentId"), prompt: textOf(p.prompt, "prompt"), steer: p.steer === true, ...(p.images === undefined ? {} : { images: imagesOf(p.images) }) };
    case "agents.interrupt":
      return { agentId: idOf(p.agentId, "agentId") };
    case "agents.dequeue":
    case "agents.sendQueuedNow":
      return { agentId: idOf(p.agentId, "agentId"), queueId: idOf(p.queueId, "queueId") };
    case "agents.cancelSteering":
      return { agentId: idOf(p.agentId, "agentId"), steeringId: idOf(p.steeringId, "steeringId") };
    case "agents.respondPermission": {
      const decision = p.decision === "allow" || p.decision === "deny" ? p.decision : fail(T.errMobileParam("decision"));
      return { agentId: idOf(p.agentId, "agentId"), itemId: idOf(p.itemId, "itemId"), decision };
    }
    case "agents.answerQuestion": {
      const answers = p.answers === null ? null : asObject(p.answers);
      if (answers) for (const [question, answer] of Object.entries(answers)) if (typeof answer !== "string" || question.length > 2000 || answer.length > 2000) fail(T.errMobileParam("answers"));
      return { agentId: idOf(p.agentId, "agentId"), itemId: idOf(p.itemId, "itemId"), answers };
    }
    case "agents.respondPlan": {
      const base = { agentId: idOf(p.agentId, "agentId"), itemId: idOf(p.itemId, "itemId") };
      if (p.approve === true) return { ...base, approve: true, mode: p.mode === "default" ? "default" : "acceptEdits" };
      return { ...base, approve: false, ...(typeof p.feedback === "string" ? { feedback: textOf(p.feedback, "feedback", 5000) } : {}) };
    }
    case "agents.markRead":
      return { agentId: idOf(p.agentId, "agentId"), read: p.read !== false };
    case "mobile.preview":
      return { agentId: idOf(p.agentId, "agentId"), itemId: idOf(p.itemId, "itemId"), target: textOf(p.target, "target", 2048) };
    case "mobile.browse": {
      const folder = resolveFolder(p.path, browseRoot);
      return { dir: folder.dir, display: folder.display };
    }
    case "workspaces.add":
      return { dir: resolveAddable(p.dir, browseRoot).dir };
    case "workspaces.remove":
      return { id: idOf(p.id, "id") };
    case "git.branches":
      return { workspaceId: idOf(p.workspaceId, "workspaceId") };
    case "git.checkBranchName":
      return { workspaceId: idOf(p.workspaceId, "workspaceId"), branch: textOf(p.branch, "branch", REF_LIMIT) };
    case "agents.setPinned":
      return { agentId: idOf(p.agentId, "agentId"), pinned: typeof p.pinned === "boolean" ? p.pinned : fail(T.errMobileParam("pinned")) };
    case "agents.setDone":
      return { agentId: idOf(p.agentId, "agentId"), done: typeof p.done === "boolean" ? p.done : fail(T.errMobileParam("done")) };
    case "agents.rename": {
      const title = typeof p.title === "string" && p.title.length <= 2000 ? p.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, TITLE_LIMIT) : fail(T.errMobileParam("title"));
      return { agentId: idOf(p.agentId, "agentId"), title };
    }
    case "agents.setOpen": {
      const ids = Array.isArray(p.agentIds) && p.agentIds.length <= 10 ? p.agentIds.map((id) => idOf(id, "agentIds")) : fail(T.errMobileParam("agentIds"));
      return { agentIds: ids };
    }
  }
  return fail(T.errMobileMethod(method));
}

export function shapeMobileEvent(event: ServerEvent): ServerEvent | null {
  if (!(MOBILE_EVENT_TYPES as readonly string[]).includes(event.type)) return null;
  switch (event.type) {
    case "workspaces":
      return { type: "workspaces", workspaces: event.workspaces.filter((w) => !w.feedback) };
    case "agent":
      return event.agent.feedbackId ? null : event;
    case "timelineUpsert":
      return { ...event, item: compactTimelineItem(event.item) };
    default:
      return event;
  }
}

export type MobileServerDeps = {
  devices: MobileDevices;
  pairing: PairingCodes;
  call: (method: string, params: Record<string, unknown>, client: WebSocket) => Promise<unknown> | unknown;
  saveImage: (bytes: Buffer, mediaType: string, name: string) => { id: string };
  serveMedia?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
  hostName: string;
  allowedOrigins?: ReadonlySet<string>;
  relayBridgeKey?: string;
  onClose?: (client: WebSocket) => void;
  onReady?: (client: WebSocket) => void;
  log?: (line: string) => void;
};

const AUTH_TIMEOUT_MS = 5000;
const MAX_UNAUTHENTICATED = 8;
const FLUSH_MS = 50;
const KEEPALIVE_MS = 15_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

function activityAgent({ id, title, status, done }: Agent) {
  return { id, title, status, done };
}

const ACTIVITY_TEXT_LIMIT = 90;
const TOOL_ACTIONS: Record<string, string> = { Read: "Reading", Edit: "Editing", MultiEdit: "Editing", Write: "Writing", Grep: "Searching", Glob: "Finding files", WebFetch: "Reading", WebSearch: "Searching the web", TodoWrite: "Updating todos", Skill: "Using" };

const clip = (text: string) => text.length > ACTIVITY_TEXT_LIMIT ? `${text.slice(0, ACTIVITY_TEXT_LIMIT - 1).trimEnd()}…` : text;
const fileName = (value: unknown) => typeof value === "string" ? value.split("/").filter(Boolean).pop() ?? null : null;
const hostOf = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

function toolActivity(name: string, input: Record<string, unknown>): string {
  const text = (key: string) => typeof input[key] === "string" ? (input[key] as string).split("\n")[0].trim() : null;
  if (name === "Bash") return text("description") ?? `Running ${text("command") ?? "a command"}`;
  if (name === "Agent" || name === "Task") return `Subagent: ${text("description") ?? "working"}`;
  const action = TOOL_ACTIONS[name];
  if (action) {
    const target = fileName(input.file_path) ?? hostOf(input.url) ?? text("pattern") ?? text("query") ?? text("skill");
    return target ? `${action} ${target}` : action;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]}: ${mcp[2].replace(/_/g, " ")}` : name;
}

function assistantActivity(text: string): string | null {
  const line = text.split("\n").map((part) => part.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim()).find(Boolean);
  if (!line) return null;
  return line.match(/^.+?[.!?。](?=\s|$)/)?.[0] ?? line;
}

function activityText(item: Extract<ServerEvent, { type: "timelineUpsert" }>["item"]): string | null {
  if (item.kind === "tool" && item.status === "running" && !item.parentToolUseId) return toolActivity(item.name, item.input);
  if (item.kind === "assistant") return assistantActivity(item.text);
  if (item.kind === "thinking") return "Thinking";
  return null;
}

function activityEvent(event: ServerEvent) {
  if (event.type === "agent") return { type: event.type, agent: activityAgent(event.agent) };
  if (event.type === "agentRemoved") return event;
  if (event.type === "timelineUpsert" && event.item.kind !== "permission") {
    const text = activityText(event.item);
    return text ? { type: "activity", agentId: event.agentId, text: clip(text) } : null;
  }
  if (event.type === "timelineUpsert" && event.item.kind === "permission" && event.item.status === "pending") {
    const entries = event.item.input.questions;
    const question = Array.isArray(entries) && entries[0]?.question;
    if (typeof question === "string") return { type: event.type, agentId: event.agentId, item: { kind: "permission", status: "pending", input: { questions: [{ question: question.slice(0, 400) }] } } };
  }
  return null;
}

export class MobileServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sockets = new Map<WebSocket, string>();
  private activitySockets = new WeakSet<WebSocket>();
  private socketRoutes = new WeakMap<WebSocket, MobileRoute>();
  private unauthenticated = 0;
  private alive = new WeakSet<WebSocket>();
  private keepalive: NodeJS.Timeout | null = null;
  private pending = new Map<string, ServerEvent>();
  private flushTimer: NodeJS.Timeout | null = null;
  private pairAttempts = new AttemptLimiter(10, 60_000);
  port = 0;
  bind = "";
  error: string | null = null;

  constructor(private deps: MobileServerDeps) {}

  get listening() {
    return this.http?.listening === true;
  }

  async start(port: number, bind: string): Promise<void> {
    if (this.http) return;
    this.error = null;
    const server = createServer((req, res) => this.onRequest(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    server.on("upgrade", (req, socket, head) => {
      const reject = (code: number) => {
        socket.write(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : code === 404 ? "Not Found" : "Service Unavailable"}\r\n\r\n`);
        socket.destroy();
      };
      if (!this.originAllowed(req)) return reject(403);
      if (requestUrl(req)?.pathname !== "/mobile/ws") return reject(404);
      if (this.unauthenticated >= MAX_UNAUTHENTICATED) return reject(503);
      const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
      const directLan = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i.test(peer)
        && !req.headers.forwarded && !req.headers["x-forwarded-for"];
      const route = this.routeOf(req, peer, directLan);
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.socketRoutes.set(ws, route);
        this.accept(ws, directLan);
      });
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
    server.on("error", (error) => this.deps.log?.(`[mobile] server error: ${error.message}`));
    this.http = server;
    this.wss = wss;
    this.port = (server.address() as { port: number }).port;
    this.bind = bind;
    this.keepalive = setInterval(() => this.ping(), KEEPALIVE_MS);
    this.keepalive.unref();
    this.deps.log?.(`[mobile] listening on ${bind}:${this.port}`);
  }

  async stop(): Promise<void> {
    const server = this.http;
    if (!server) return;
    this.http = null;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
    this.deps.pairing.clear();
    for (const ws of this.sockets.keys()) ws.close(1001, "mobile access turned off");
    this.sockets.clear();
    this.wss?.close();
    this.wss = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.deps.log?.("[mobile] stopped");
  }

  onlineDeviceIds(): Set<string> {
    return new Set(this.sockets.values());
  }

  dropDevice(deviceId: string) {
    for (const [ws, id] of this.sockets) {
      if (id !== deviceId) continue;
      this.sockets.delete(ws);
      ws.close(4001, "device removed");
    }
  }

  deviceExists(id: string): boolean {
    return this.deps.devices.list().some((d) => d.id === id);
  }

  revokeDevice(id: string) {
    this.deps.devices.revoke(id);
    this.dropDevice(id);
  }

  devices(): MobileDevice[] {
    const routes = new Map<string, MobileRoute>();
    for (const [ws, id] of this.sockets) if (!routes.has(id) || !this.activitySockets.has(ws)) routes.set(id, this.socketRoutes.get(ws) ?? "other");
    return this.deps.devices.list().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online: routes.has(d.id), route: routes.get(d.id) ?? null }));
  }

  private routeOf(req: IncomingMessage, peer: string, directLan: boolean): MobileRoute {
    const bridge = req.headers["x-lodestar-relay-bridge"];
    const key = this.deps.relayBridgeKey;
    if (key && typeof bridge === "string" && bridge.length === key.length && timingSafeEqual(Buffer.from(bridge), Buffer.from(key)) && /^(127\.|::1$)/.test(peer)) return "relay";
    const [a, b] = peer.split(".").map(Number);
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    return directLan ? "lan" : "other";
  }

  broadcast(event: ServerEvent) {
    if (this.sockets.size === 0) return;
    const shaped = shapeMobileEvent(event);
    if (!shaped) return;
    if (shaped.type === "timelineUpsert" || shaped.type === "agent") {
      const key = shaped.type === "agent" ? `agent:${shaped.agent.id}` : `item:${shaped.agentId}:${shaped.item.id}`;
      this.pending.delete(key);
      this.pending.set(key, shaped);
      this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
      return;
    }
    this.flush();
    this.send(shaped);
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) this.send(event);
  }

  private send(event: ServerEvent) {
    let full: string | undefined;
    let summary: string | null | undefined;
    for (const ws of this.sockets.keys()) {
      if (this.activitySockets.has(ws)) {
        if (summary === undefined) {
          const activity = activityEvent(event);
          summary = activity ? JSON.stringify({ event: activity }) : null;
        }
        if (summary) this.sendTo(ws, summary);
      } else {
        full ??= JSON.stringify({ event });
        this.sendTo(ws, full);
      }
    }
  }

  private sendTo(ws: WebSocket, text: string) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws.terminate();
      return;
    }
    ws.send(text);
  }

  private ping() {
    for (const ws of this.sockets.keys()) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }

  // Origin 이 없으면 통과한다. 있으면 두 경우만 받는다.
  // 1. React Native(iOS)는 연결한 주소 그대로를 Origin 으로 보낸다(Host 와 같은 http://<IP>:<포트>). 호스트가 IP 주소나 .local 이름일 때만 인정한다.
  // 2. 시험용으로 허용 목록(AGENT_NAV_MOBILE_ALLOW_ORIGIN)에 적은 Origin.
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined || this.deps.allowedOrigins?.has(origin) === true) return true;
    const host = req.headers.host ?? "";
    if (origin !== `http://${host}`) return false;
    const name = host.replace(/:\d+$/, "");
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^\[[0-9a-f:]+\]$/i.test(name) || /\.local$/i.test(name);
  }

  private accept(ws: WebSocket, directLan: boolean) {
    this.unauthenticated += 1;
    let counted = true;
    const settle = () => {
      if (counted) {
        counted = false;
        this.unauthenticated -= 1;
      }
    };
    const timer = setTimeout(() => ws.close(4401, "auth timeout"), AUTH_TIMEOUT_MS);
    let wasAuthed = false;
    let challenge: ReturnType<MobileDevices["challenge"]> = null;
    ws.on("pong", () => this.alive.add(ws));
    ws.on("close", () => {
      clearTimeout(timer);
      settle();
      if (wasAuthed) this.deps.onClose?.(ws);
      this.sockets.delete(ws);
    });
    ws.on("error", () => ws.terminate());
    ws.on("message", async (data, isBinary) => {
      this.alive.add(ws);
      if (isBinary) return ws.close(1003, "text only");
      let message: Record<string, unknown>;
      try {
        message = asObject(JSON.parse(data.toString()));
      } catch {
        return ws.close(1007, "bad json");
      }
      if (!wasAuthed) {
        if (!challenge && "routeDeviceId" in message) {
          if (!directLan) return ws.close(4403, "direct LAN required");
          challenge = this.deps.devices.challenge(message.routeDeviceId, message.routeNonce);
          if (!challenge) return ws.close(4401, "bad token");
          ws.send(JSON.stringify({ routeChallenge: challenge.challenge, routeProof: challenge.proof }));
          return;
        }
        let device: DeviceRecord | null = null;
        if (challenge) {
          if (typeof message.routeAuth === "string" && TOKEN_RE.test(message.routeAuth) &&
              timingSafeEqual(Buffer.from(challenge.auth, "hex"), Buffer.from(message.routeAuth, "hex")) &&
              this.deps.devices.list().includes(challenge.device)) device = challenge.device;
          challenge = null;
        } else {
          device = this.deps.devices.verify(message.auth);
        }
        if (!device) return ws.close(4401, "bad token");
        wasAuthed = true;
        clearTimeout(timer);
        settle();
        this.sockets.set(ws, device.id);
        if (message.feed === "activity") this.activitySockets.add(ws);
        this.alive.add(ws);
        this.deps.devices.touch(device.id);
        const ready: MobileReady = { protocol: MOBILE_PROTOCOL, host: this.deps.hostName, serverTime: Date.now() };
        ws.send(JSON.stringify({ ready }));
        if (message.feed !== "activity") this.deps.onReady?.(ws);
        return;
      }
      const id = typeof message.id === "number" ? message.id : -1;
      try {
        const method = typeof message.method === "string" ? message.method : "";
        const params = guardMobileCall(method, message.params);
        const activity = this.activitySockets.has(ws);
        if (activity && method !== "agents.list" && method !== "mobile.ping") throw new Error(T.errMobileMethod(method));
        const result = await this.deps.call(method, params, ws);
        this.sendTo(ws, JSON.stringify({ id, result: activity && method === "agents.list" && Array.isArray(result) ? result.map(activityAgent) : result }));
      } catch (error) {
        this.sendTo(ws, JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse) {
    if (!this.originAllowed(req)) return json(res, 403, { error: "forbidden" });
    const url = requestUrl(req);
    if (!url) return json(res, 404, { error: "not found" });
    if (req.method === "GET" && url.pathname === "/mobile/health") return json(res, 200, { ok: true, protocol: MOBILE_PROTOCOL });
    if (req.method === "POST" && url.pathname === "/mobile/pair") return void this.pair(req, res);
    if (req.method === "POST" && url.pathname === "/mobile/images") return void this.uploadImage(req, res, url);
    if (url.pathname === MOBILE_MEDIA_PATH && this.deps.serveMedia) return void this.serveMedia(this.deps.serveMedia, req, res, url);
    json(res, 404, { error: "not found" });
  }

  private async pair(req: IncomingMessage, res: ServerResponse) {
    if (!this.pairAttempts.take()) return json(res, 429, { error: T.errMobilePairLimited });
    let body: Record<string, unknown>;
    try {
      body = asObject(JSON.parse((await readBody(req, 2048)).toString("utf8")));
    } catch {
      return json(res, 400, { error: T.errMobileParam("body") });
    }
    const outcome = this.redeemPairing(body.code, body.deviceName);
    if (outcome.ok) json(res, 200, outcome.result);
    else json(res, outcome.status, { error: outcome.error });
  }

  pairOverRelay(code: unknown, deviceName: unknown, relayKey: string): PairOutcome {
    if (!this.listening) return { ok: false, status: 503, error: T.errMobileOff };
    if (!this.pairAttempts.take()) return { ok: false, status: 429, error: T.errMobilePairLimited };
    return this.redeemPairing(code, deviceName, relayKey);
  }

  private redeemPairing(code: unknown, deviceName: unknown, relayKey?: string): PairOutcome {
    const result = this.deps.pairing.redeem(code);
    if (result === "locked") return { ok: false, status: 429, error: T.errMobilePairLocked };
    if (result === "expired") return { ok: false, status: 401, error: T.errMobilePairExpired };
    if (result !== "ok") return { ok: false, status: 401, error: T.errMobilePairInvalid };
    const { device, token } = this.deps.devices.add(deviceName, relayKey);
    this.deps.log?.(`[mobile] paired ${device.name}${relayKey ? " over the relay" : ""}`);
    return { ok: true, result: { deviceId: device.id, deviceToken: token, host: this.deps.hostName, protocol: MOBILE_PROTOCOL } };
  }

  private async serveMedia(serve: NonNullable<MobileServerDeps["serveMedia"]>, req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      await serve(req, res, url);
    } catch (error) {
      this.deps.log?.(`[mobile] media failed ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500).end("media failed");
    }
  }

  private async uploadImage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const auth = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
    const device = auth ? this.deps.devices.verify(auth[1]) : null;
    if (!device) {
      req.resume();
      return json(res, 401, { error: "unauthorized" });
    }
    const tooLarge = () => {
      res.setHeader("connection", "close");
      json(res, 413, { error: T.errMobileImageTooLarge(MAX_IMAGE_BYTES / 1024 / 1024) });
      res.on("finish", () => req.socket.destroySoon());
    };
    if (Number(req.headers["content-length"] ?? 0) > MAX_IMAGE_BYTES) return tooLarge();
    let bytes: Buffer;
    try {
      bytes = await readBody(req, MAX_IMAGE_BYTES);
    } catch {
      return tooLarge();
    }
    const rawName = req.headers["x-image-name"];
    let name = "image";
    try {
      name = decodeURIComponent(typeof rawName === "string" ? rawName : url.searchParams.get("name") ?? "image");
    } catch {
    }
    try {
      json(res, 200, this.deps.saveImage(bytes, String(req.headers["content-type"] ?? ""), name));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function requestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://mobile");
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" }).end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
