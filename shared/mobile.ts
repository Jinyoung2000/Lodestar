// MOBILE: iOS 클라이언트(mobile/)가 데몬의 모바일 포트와 주고받는 값. 데몬(server/mobileAccess.ts), 웹 Settings, 모바일 앱이 같은 모양을 쓴다.
import type { SwitchBlock } from "./harnessSwitch";
import type { PickerModel } from "./modelChoices";
import type { EffortLevel, Harness, ImageRef, RequestQueuing, TimelineItem } from "./protocol";

export const MOBILE_PROTOCOL = 1;

// 모바일 연결에 허용하는 RPC 의 전부. 여기 없는 메서드(파일 쓰기, 설정 변경, 터미널, 셸 실행, 페어링 관리 등)는 데몬이 실행하기 전에 거절한다.
// 이미지 올리기는 RPC 가 아니라 HTTP(POST /mobile/images)로 한다.
export const MOBILE_METHODS = [
  "mobile.ping",
  "mobile.defaults",
  "mobile.workspaceIcons",
  "workspaces.list",
  "agents.list",
  "agents.timelinePage",
  "agents.create",
  "agents.send",
  "agents.interrupt",
  "agents.dequeue",
  "agents.sendQueuedNow",
  "agents.cancelSteering",
  "agents.respondPermission",
  "agents.answerQuestion",
  "agents.respondPlan",
  "agents.markRead",
  "agents.setOpen",
  // 워크스페이스: 홈 아래 폴더 둘러보기와 추가, 목록에서 빼기(파일은 지우지 않는다), worktree 시작 전 브랜치 읽기, 세션 이름 바꾸기와 고정과 보관(done).
  // 세션 삭제(agents.remove)와 worktree 삭제는 되돌릴 수 없어 열지 않는다.
  "mobile.browse",
  "mobile.preview",
  "mobile.models",
  "models.pins",
  "models.setPin",
  "mobile.setModel",
  "mobile.createSession",
  "workspaces.add",
  "workspaces.remove",
  "git.branches",
  "git.checkBranchName",
  "agents.setPinned",
  "agents.setDone",
  "agents.rename",
] as const;
export type MobileMethod = (typeof MOBILE_METHODS)[number];

// 모바일에 보내는 서버 이벤트 종류. 설정, 받은편지함, 보드, 메모, Notion, 피드백 같은 데스크톱 전용 이벤트는 보내지 않는다.
export const MOBILE_EVENT_TYPES = ["workspaces", "agent", "agentRemoved", "timelineUpsert", "timelineRemove", "modelPins"] as const;

// 연결 직후 인증을 마치면 서버가 한 번 보내는 메시지
export type MobileReady = { protocol: number; host: string; serverTime: number };

export type MobileDefaults = { requestQueuing: RequestQueuing };

export type MobileWorkspaceIcons = Record<string, string | null>;

export const MOBILE_MEDIA_PATH = "/mobile/media";

export type MobilePreview = { kind: "html"; html: string } | { kind: "image" | "video"; uri: string } | { kind: "markdown" | "svg" | "csv"; text: string };

export type MobileHost = { address: string; iface: string; kind: "lan" | "tailscale" };

export type MobileRoute = "lan" | "tailscale" | "relay" | "tunnel" | "other";
export type MobileDevice = { id: string; name: string; createdAt: string; lastSeenAt: string | null; online: boolean; route: MobileRoute | null };

export type MobileRelayState = "off" | "unconfigured" | "connecting" | "online" | "error";
export type MobileRelayLinkState = { state: MobileRelayState; error: string | null };
export type MobileRelayStatus = MobileRelayLinkState & { host: string | null };

export type MobileStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  bind: string;
  hosts: MobileHost[];
  devices: MobileDevice[];
  error: string | null;
  relay: MobileRelayStatus;
};

export type MobileRelayPairing = { url: string; id: string; key: string };

export type PairingOffer = {
  // 표시용: ABCD-EFGH
  code: string;
  expiresAt: number;
  // QR 에 담는 주소: lodestar://pair?v=1&h=192.168.0.5,100.64.0.1&p=7789&c=ABCDEFGH&n=Mac
  uri: string;
  // 수동 입력용 한 줄: 192.168.0.5:7789 ABCD-EFGH
  manual: string;
  hosts: MobileHost[];
  port: number;
  relay: boolean;
};

export type PairResult = { deviceId: string; deviceToken: string; host: string; protocol: number };

// mobile.browse: 홈(데몬이 AGENT_NAV_MOBILE_BROWSE_ROOT 로 바꿀 수 있다) 아래 폴더를 한 단계씩 둘러본다. 경로는 항상 "~" 로 시작하는 표시용 경로이고, 파일 내용과 파일 이름은 주지 않는다.
export type MobileBrowseEntry = { name: string; git: boolean; workspaceId: string | null };
export type MobileBrowseResult = {
  // "~" 이거나 "~/Repository/app" 꼴
  path: string;
  // 한 단계 위(홈 자체면 null)
  parent: string | null;
  // 이 폴더가 git 저장소인지(.git 이 폴더나 파일로 있는지)
  git: boolean;
  // 이 폴더가 이미 워크스페이스면 그 id
  workspaceId: string | null;
  entries: MobileBrowseEntry[];
  // 항목이 상한(500)을 넘어 잘렸는지
  truncated: boolean;
};

// agents.create 에 폰이 보내는 worktree. 기준 브랜치(base)에서 새 브랜치(branch)로 갈라진다.
export type MobileWorktreeRequest = { branch: string; base: string };

export type MobileModelSelection = { harness: Harness; model: string | null; effort: EffortLevel | null };
export type MobileModel = Pick<PickerModel, "value" | "resolved" | "displayName" | "levels" | "defaultLevel"> & { pinKey?: string };
export type MobileModelProvider = { harness: Harness; models: MobileModel[]; defaultModel: string | null; defaultModelKnown: boolean };
export type MobileModelCatalog = { providers: MobileModelProvider[]; switchBlock: SwitchBlock | null };
export type MobileSessionRequest = { workspaceId: string | null; prompt: string; images?: ImageRef[]; worktree?: MobileWorktreeRequest };

export function mobileModelId(value: unknown): value is string {
  return typeof value === "string" && /^[\w.[\]:/-]{1,200}$/.test(value) && !value.startsWith("-");
}

export type TimelinePage = { items: TimelineItem[]; hasMore: boolean; total: number };

export const MOBILE_OUTPUT_CHARS = 4000;
export const MOBILE_INPUT_CHARS = 2000;
export const MOBILE_THINKING_CHARS = 1200;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function clipValue(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === "string") return clip(value, max);
  if (depth >= 3 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clipValue(v, max, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clipValue(v, max, depth + 1)]));
}

export function compactTimelineItem(item: TimelineItem): TimelineItem {
  switch (item.kind) {
    case "tool": {
      const { shots, ...rest } = item;
      return { ...rest, ...(shots?.length && { shotCount: shots.length }), input: clipValue(item.input, MOBILE_INPUT_CHARS) as Record<string, unknown>, output: item.output === null ? null : clip(item.output, MOBILE_OUTPUT_CHARS) };
    }
    case "thinking":
      return { ...item, text: clip(item.text, MOBILE_THINKING_CHARS) };
    case "permission": {
      const { notion: _notion, ...rest } = item;
      return { ...rest, input: clipValue(item.input, MOBILE_INPUT_CHARS) as Record<string, unknown> };
    }
    case "notice":
      return { ...item, ...(item.detail === undefined ? {} : { detail: clip(item.detail, MOBILE_OUTPUT_CHARS) }), ...(item.fold ? { fold: { label: item.fold.label, text: clip(item.fold.text, MOBILE_OUTPUT_CHARS) } } : {}) };
    default:
      return item;
  }
}

// 끝에서 limit 개를 읽는다. beforeId 가 있으면 그 항목 바로 앞까지의 끝에서 limit 개(옛 항목을 더 불러올 때). 목록에 없는 beforeId 는 맨 끝으로 본다.
export function pageOfTimeline(items: readonly TimelineItem[], limit: number, beforeId?: string): TimelinePage {
  const at = beforeId === undefined ? -1 : items.findIndex((i) => i.id === beforeId);
  const end = at === -1 ? items.length : at;
  const start = Math.max(0, end - Math.max(1, Math.floor(limit)));
  return { items: items.slice(start, end).map(compactTimelineItem), hasMore: start > 0, total: items.length };
}

export function pairingCodeLabel(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function buildPairingUri(parts: { hosts: string[]; port: number; code: string; name: string; relay?: MobileRelayPairing | null }): string {
  const query = new URLSearchParams({ v: String(MOBILE_PROTOCOL), h: parts.hosts.join(","), p: String(parts.port), c: parts.code, n: parts.name, ...(parts.relay ? { r: parts.relay.url, i: parts.relay.id, k: parts.relay.key } : {}) });
  return `lodestar://pair?${query.toString()}`;
}

export function buildManualPairing(host: string, port: number, code: string): string {
  return `${host}:${port} ${pairingCodeLabel(code)}`;
}
