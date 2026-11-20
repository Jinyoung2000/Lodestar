// MOBILE: iOS 앱(mobile/)이 LAN 으로 붙는 길. 기본은 꺼져 있고(설정 mobileAccess), 켜면 데스크톱용 서버와 완전히 별개인 서버를 따로 연다.
// 별개 서버로 둔 이유: 데스크톱 서버의 Host/Origin 검사, 메인 토큰, 정적 파일 응답을 건드리지 않고(꺼져 있으면 이 파일의 서버는 존재하지 않는다),
// 모바일 포트는 JSON 몇 개와 WebSocket 하나, 이미지 업로드 하나만 받는다. 메인 토큰은 이 서버에서 통하지 않고, 장치마다 다른 장치 토큰만 통한다.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildManualPairing, buildPairingUri, MOBILE_EVENT_TYPES, MOBILE_METHODS, MOBILE_PROTOCOL, compactTimelineItem, pairingCodeLabel, type MobileDevice, type MobileHost, type MobileReady, type PairingOffer } from "../shared/mobile";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "../shared/images";
import type { ServerEvent } from "../shared/protocol";
import { resolveAddable, resolveFolder } from "./mobileFolders";
import { T } from "./strings";

// 읽기 쉬운 글자만 쓴다(I, O, 0, 1 제외). 32^8 가지에 5분 유효, 한 번만 쓰고, 틀리면 5번 만에 코드가 사라진다.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_FAILURES = 5;

export type RedeemResult = "ok" | "invalid" | "expired" | "locked";

export class PairingCodes {
  private current: { code: string; expiresAt: number; failures: number } | null = null;

  constructor(private opts: { ttlMs?: number; maxFailures?: number; now?: () => number } = {}) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  // 새 코드를 만든다. 이전 코드는 그 순간 못 쓴다(한 번에 하나).
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

// 짧은 시간에 몰리는 시도를 거른다(코드가 없을 때 계속 두드리는 경우까지 포함).
export class AttemptLimiter {
  private times: number[] = [];

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  // 허용하면 true 이고 시도로 센다.
  take(): boolean {
    const cutoff = this.now() - this.windowMs;
    this.times = this.times.filter((t) => t > cutoff);
    if (this.times.length >= this.max) return false;
    this.times.push(this.now());
    return true;
  }
}

type DeviceRecord = { id: string; name: string; tokenHash: string; createdAt: string; lastSeenAt: string | null };

const TOKEN_RE = /^[0-9a-f]{64}$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// 페어링된 장치. 토큰 원문은 장치에만 있고, 이 파일에는 sha256 만 남는다(파일이 새도 토큰을 되살릴 수 없다).
export class MobileDevices {
  private records: DeviceRecord[];

  constructor(private file: string) {
    this.records = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DeviceRecord[]) : [];
  }

  list(): DeviceRecord[] {
    return this.records;
  }

  add(rawName: unknown): { device: DeviceRecord; token: string } {
    const name = typeof rawName === "string" ? rawName.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "";
    const token = randomBytes(32).toString("hex");
    const device: DeviceRecord = { id: randomUUID(), name: name || "iPhone", tokenHash: sha256(token), createdAt: new Date().toISOString(), lastSeenAt: null };
    this.records.push(device);
    this.save();
    return { device, token };
  }

  // 토큰이 맞는 장치. 모든 장치와 같은 시간에 비교한다.
  verify(token: unknown): DeviceRecord | null {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const hash = Buffer.from(sha256(token), "hex");
    let found: DeviceRecord | null = null;
    for (const record of this.records) if (timingSafeEqual(hash, Buffer.from(record.tokenHash, "hex"))) found = record;
    return found;
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

// 이 맥의 LAN 주소 후보. 가상 인터페이스(VPN 터널, AirDrop, 브리지, 컨테이너)와 링크 로컬은 뺀다. Wi-Fi(en0)가 맨 앞이다.
const VIRTUAL_IFACE = /^(utun|awdl|llw|bridge|vmenet|veth|docker|vboxnet|ap\d|gif|stf|anpi|lo)/;

export function lanHosts(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): MobileHost[] {
  const hosts: MobileHost[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal || info.address.startsWith("169.254.")) continue;
      // Tailscale 은 utun 이라 위 필터가 거르지만, 100.64.0.0/10 주소가 일반 인터페이스에 붙어 있으면 그 표시를 한다(relay 대신 Tailscale 로 붙는 2단계에서 쓴다).
      const [a, b] = info.address.split(".").map(Number);
      const tailscale = a === 100 && b >= 64 && b <= 127;
      if (VIRTUAL_IFACE.test(iface) && !tailscale) continue;
      hosts.push({ address: info.address, iface, kind: tailscale ? "tailscale" : "lan" });
    }
  }
  return hosts.sort((x, y) => Number(y.iface === "en0") - Number(x.iface === "en0") || Number(x.kind === "tailscale") - Number(y.kind === "tailscale"));
}

export function makeOffer(issued: { code: string; expiresAt: number }, hosts: MobileHost[], port: number, name: string): PairingOffer {
  const first = hosts[0]?.address ?? "127.0.0.1";
  return {
    code: pairingCodeLabel(issued.code),
    expiresAt: issued.expiresAt,
    uri: buildPairingUri({ hosts: hosts.map((h) => h.address), port, code: issued.code, name }),
    manual: buildManualPairing(first, port, issued.code),
    hosts,
    port,
  };
}

// --- 호출 검사 ---

const METHOD_SET: ReadonlySet<string> = new Set(MOBILE_METHODS);
const ID_LIMIT = 200;
const PROMPT_LIMIT = 50_000;
const THUMB_LIMIT = 30_000;
const UUID_RE = /^[0-9a-f-]{36}$/;
// worktree 의 브랜치와 기준 브랜치 이름 상한. git 의 refname 은 이보다 짧게 쓰인다.
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

// worktree 의 브랜치 이름과 기준 브랜치. 기준 브랜치는 git 명령의 인자로 넘어가므로 "-" 로 시작하는 값(`--` 가 없는 명령에서는 옵션으로 읽힌다)과 공백, 제어 문자를 막는다.
// 브랜치 이름의 git 규칙(check-ref-format)과 이미 있는 이름은 데몬이 addWorktree 에서 다시 판정하고, 기준 브랜치가 실제 브랜치인지도 데몬이 목록으로 대조한다.
function refOf(value: unknown, name: string): string {
  const text = typeof value === "string" ? value : "";
  return text.length > 0 && text.length <= REF_LIMIT && !text.startsWith("-") && !/[\s\u0000-\u001f\u007f]/.test(text) ? text : fail(T.errMobileParam(name));
}

function worktreeOf(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const w = asObject(value);
  return { branch: refOf(w.branch, "branch"), base: refOf(w.base, "base") };
}

// 모바일이 부를 수 있는 RPC 와 그 인자를 확인하고, 데몬 핸들러에 넘길 인자를 새 객체로 만든다. 모르는 메서드와 모양이 어긋난 인자는 던진다.
// 데스크톱에서 오는 호출은 이 검사를 거치지 않는다(그쪽은 같은 사용자가 연 화면이다).
// browseRoot: 폴더 둘러보기와 워크스페이스 추가가 갇히는 홈. 기본은 mobileFolders 가 정한다(시험은 임시 폴더를 준다).
export function guardMobileCall(method: string, raw: unknown, browseRoot?: string): Record<string, unknown> {
  if (!METHOD_SET.has(method)) fail(T.errMobileMethod(method));
  const p = asObject(raw);
  switch (method) {
    case "mobile.ping":
    case "workspaces.list":
    case "agents.list":
      return {};
    case "agents.timelinePage": {
      const limit = typeof p.limit === "number" && Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= 200 ? p.limit : fail(T.errMobileParam("limit"));
      return { agentId: idOf(p.agentId, "agentId"), limit, ...(p.beforeId === undefined ? {} : { beforeId: idOf(p.beforeId, "beforeId") }) };
    }
    case "agents.create": {
      const workspaceId = p.workspaceId === null ? null : idOf(p.workspaceId, "workspaceId");
      const worktree = worktreeOf(p.worktree);
      // 폴더 없는 대화(Chat)에는 worktree 가 없다
      if (worktree && workspaceId === null) fail(T.errMobileParam("worktree"));
      return { workspaceId, prompt: textOf(p.prompt, "prompt"), ...(p.images === undefined ? {} : { images: imagesOf(p.images) }), ...(worktree ? { worktree } : {}) };
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
      // allowAlways 는 데스크톱의 영구 허용 규칙을 쓰는 결정이라 폰에서는 못 한다.
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
    case "mobile.browse": {
      const folder = resolveFolder(p.path, browseRoot);
      return { dir: folder.dir, display: folder.display };
    }
    // 홈 아래 실제 폴더만. 홈 자체와 숨김, 제외 폴더는 거절한다. 데몬 핸들러에는 풀어 낸 절대 경로를 넘긴다.
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
      // 제어 문자는 공백으로 바꾸고 200자로 자른다. 비어 있는 이름은 데몬이 거절한다.
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

// 서버 이벤트를 모바일용으로 거른다. 보내지 않을 이벤트는 null. 항목은 줄여서 보낸다.
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

// --- 서버 ---

export type MobileServerDeps = {
  devices: MobileDevices;
  pairing: PairingCodes;
  // 허용 목록과 인자 검사를 통과한 호출을 실행한다(데몬의 핸들러)
  call: (method: string, params: Record<string, unknown>, client: WebSocket) => Promise<unknown> | unknown;
  saveImage: (bytes: Buffer, mediaType: string, name: string) => { id: string };
  hostName: string;
  // 브라우저가 아닌 클라이언트(React Native)는 Origin 을 보내지 않는다. Origin 이 있는 요청은 브라우저 페이지에서 온 것이라 기본으로 거절한다. 시험에서 웹 빌드를 붙일 때만 허용 목록을 준다.
  allowedOrigins?: ReadonlySet<string>;
  onClose?: (client: WebSocket) => void;
  log?: (line: string) => void;
};

const AUTH_TIMEOUT_MS = 5000;
const MAX_UNAUTHENTICATED = 8;
const FLUSH_MS = 50;
const KEEPALIVE_MS = 15_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
// 보내기 한 번은 글 5만 자(한글은 150KB 가까이)와 첨부 미리보기 5개(각 30KB)를 함께 실을 수 있어 1MB 로 둔다
const MAX_FRAME_BYTES = 1024 * 1024;

export class MobileServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sockets = new Map<WebSocket, string>();
  private unauthenticated = 0;
  private alive = new WeakSet<WebSocket>();
  private keepalive: NodeJS.Timeout | null = null;
  // 같은 항목의 스트리밍 갱신은 50ms 마다 마지막 것만 보낸다. 글이 흘러나오는 동안 폰의 렌더링이 따라가게 한다.
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

  // 장치를 해제하면 그 장치의 열린 연결도 바로 끊는다.
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

  // 장치를 목록에서 빼고(토큰이 더는 통하지 않는다) 열린 연결도 끊는다.
  revokeDevice(id: string) {
    this.deps.devices.revoke(id);
    this.dropDevice(id);
  }

  devices(): MobileDevice[] {
    const online = this.onlineDeviceIds();
    return this.deps.devices.list().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online: online.has(d.id) }));
  }

  broadcast(event: ServerEvent) {
    if (this.sockets.size === 0) return;
    const shaped = shapeMobileEvent(event);
    if (!shaped) return;
    if (shaped.type === "timelineUpsert" || shaped.type === "agent") {
      const key = shaped.type === "agent" ? `agent:${shaped.agent.id}` : `item:${shaped.agentId}:${shaped.item.id}`;
      // 맨 뒤로 보내 순서를 지킨다: 같은 키의 옛 갱신을 지우고 최신 것을 끝에 둔다.
      this.pending.delete(key);
      this.pending.set(key, shaped);
      this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
      return;
    }
    // 항목 삭제 같은 이벤트가 앞선 갱신을 앞지르지 않게 쌓인 것부터 보낸다.
    this.flush();
    this.send(JSON.stringify({ event: shaped }));
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) this.send(JSON.stringify({ event }));
  }

  private send(text: string) {
    for (const ws of this.sockets.keys()) this.sendTo(ws, text);
  }

  private sendTo(ws: WebSocket, text: string) {
    if (ws.readyState !== ws.OPEN) return;
    // 폰이 못 따라와 쌓이면 끊는다. 다시 붙을 때 목록과 타임라인 끝을 새로 받아 맞춘다.
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
  //    다른 사이트의 웹페이지는 자기 도메인이 Origin 이고, DNS rebinding 으로 이 포트를 겨눠도 호스트 이름이 일반 도메인이라 걸러진다.
  // 2. 시험용으로 허용 목록(AGENT_NAV_MOBILE_ALLOW_ORIGIN)에 적은 Origin.
  // 어느 쪽이든 장치 토큰이 없으면 아무것도 실행되지 않는다(이 검사는 겹겹이 두는 방어다).
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined || this.deps.allowedOrigins?.has(origin) === true) return true;
    const host = req.headers.host ?? "";
    if (origin !== `http://${host}`) return false;
    const name = host.replace(/:\d+$/, "");
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^\[[0-9a-f:]+\]$/i.test(name) || /\.local$/i.test(name);
  }

  private accept(ws: WebSocket) {
    this.unauthenticated += 1;
    // 인증 전 연결 수를 한 번만 센다(인증이나 종료 중 먼저 오는 쪽에서 줄인다)
    let counted = true;
    const settle = () => {
      if (counted) {
        counted = false;
        this.unauthenticated -= 1;
      }
    };
    const timer = setTimeout(() => ws.close(4401, "auth timeout"), AUTH_TIMEOUT_MS);
    let wasAuthed = false;
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
        const device = this.deps.devices.verify(message.auth);
        if (!device) return ws.close(4401, "bad token");
        wasAuthed = true;
        clearTimeout(timer);
        settle();
        this.sockets.set(ws, device.id);
        this.alive.add(ws);
        this.deps.devices.touch(device.id);
        const ready: MobileReady = { protocol: MOBILE_PROTOCOL, host: this.deps.hostName, serverTime: Date.now() };
        ws.send(JSON.stringify({ ready }));
        return;
      }
      const id = typeof message.id === "number" ? message.id : -1;
      try {
        const method = typeof message.method === "string" ? message.method : "";
        const params = guardMobileCall(method, message.params);
        this.sendTo(ws, JSON.stringify({ id, result: await this.deps.call(method, params, ws) }));
      } catch (error) {
        this.sendTo(ws, JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  // --- HTTP ---

  private onRequest(req: IncomingMessage, res: ServerResponse) {
    if (!this.originAllowed(req)) return json(res, 403, { error: "forbidden" });
    const url = requestUrl(req);
    if (!url) return json(res, 404, { error: "not found" });
    if (req.method === "GET" && url.pathname === "/mobile/health") return json(res, 200, { ok: true, protocol: MOBILE_PROTOCOL });
    if (req.method === "POST" && url.pathname === "/mobile/pair") return void this.pair(req, res);
    if (req.method === "POST" && url.pathname === "/mobile/images") return void this.uploadImage(req, res, url);
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
    const result = this.deps.pairing.redeem(body.code);
    if (result === "locked") return json(res, 429, { error: T.errMobilePairLocked });
    if (result === "expired") return json(res, 401, { error: T.errMobilePairExpired });
    if (result !== "ok") return json(res, 401, { error: T.errMobilePairInvalid });
    const { device, token } = this.deps.devices.add(body.deviceName);
    this.deps.log?.(`[mobile] paired ${device.name}`);
    json(res, 200, { deviceId: device.id, deviceToken: token, host: this.deps.hostName, protocol: MOBILE_PROTOCOL });
  }

  private async uploadImage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const auth = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
    const device = auth ? this.deps.devices.verify(auth[1]) : null;
    if (!device) {
      req.resume();
      return json(res, 401, { error: "unauthorized" });
    }
    const tooLarge = () => {
      // 남은 본문은 읽지 않는다. 응답을 다 보낸 뒤 연결을 닫는다.
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
      // 이름은 표시용이라 못 읽으면 기본값을 쓴다
    }
    try {
      json(res, 200, this.deps.saveImage(bytes, String(req.headers["content-type"] ?? ""), name));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

// 요청 주소가 URL 로 읽히지 않으면(예: "//[") null. new URL 이 던지는 것을 잡지 않으면 인증 전 요청 하나로 데몬 전체가 죽는다.
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

// 본문을 limit 바이트까지만 받는다. 넘으면 그 순간 던져서 더 읽지 않는다.
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
