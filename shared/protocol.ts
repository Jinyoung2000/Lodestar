import type { ActivityBarPrefs } from "./activityBar";
import type { EditorOptions, ResolvedEditorOptions } from "./editorOptions";
import type { SearchSettings } from "./searchSettings";
import type { PrRpcMethods } from "./prTypes";
import type { LinearIssueRef, LinearRpcMethods } from "./linear"; // LINEAR
import type { SimulatorRpcMethods } from "./simulator"; // CMDT
import type { SkillsRpcMethods } from "./skills"; // SKILLS
import type { ScmCommit, ScmCommitFile, ScmCommitOptions, ScmCommitResult, ScmDiffSection, ScmDiscardResult, ScmFileDiff, ScmOperationResult, ScmPullMode, ScmRepoWorktrees, ScmStatus, ScmSyncResult, ScmTarget } from "./scm";
import type { SlackLinkTarget } from "./slackLink";
import type { NotionLinkTarget } from "./notionLink";
import type { NotionPin, NotionPinInput, NotionPinPatch } from "./notionPins";
import type { Note, NoteDoc } from "./notes"; // NOTES
import type { ReviewState } from "./morningReview"; // MORNINGREVIEW
import type { ReleaseState } from "./release"; // RELEASE
import type { NotionPageData } from "./notionFetch"; // NOTION2
import type { NotionWritePreview } from "./notionWrite"; // NOTION2
import type { NotionBypassWrites } from "./notionApproval"; // NOTION3
import type { ReplaceFileRequest, ReplaceFileResult } from "./searchReplace"; // SEARCHREPLACE
import type { TermAskContext } from "./termAsk";
import type { MobileStatus, PairingOffer, TimelinePage } from "./mobile"; // MOBILE
import type { SessionOrders } from "./sessionOrder"; // SESSIONORDER
import type { RetentionPolicy, TidyPlan, TidyResult } from "./feedbackRetention"; // PERFDAEMON
export type Workspace = {
  id: string;
  name: string;
  dir: string;
  // worktree 세션을 위해 자동으로 만든 워크스페이스는 사이드바에 따로 보이지 않고 원래 프로젝트 아래에 붙는다.
  parentId: string | null;
  // 피드백 개선 세션의 worktree 용 워크스페이스. 사이드바의 프로젝트 목록에는 나오지 않는다.
  feedback?: boolean;
  // PERFDAEMON: 끝난 피드백의 worktree 를 치운 워크스페이스. 목록(store.workspaces, workspaces 이벤트)에서는 빠지고, 세션이 가리키는 id 로는 계속 찾을 수 있다.
  archived?: boolean;
};

export type AgentStatus = "idle" | "running" | "waiting" | "error";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
// permbug: 메뉴 순서(Ask Before Edits 부터 Bypass Permissions 까지)이자, 저장값과 훅 입력을 거르는 허용 목록
export const PERMISSION_MODE_VALUES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export type Worktree = { root: string; branch: string; base: string };

// CODEX: 세션을 돌리는 에이전트 도구. 없으면 claude(옛 저장본과 모바일 앱이 이 필드를 몰라도 그대로 Claude 세션이다).
export type Harness = "claude" | "codex";
export const HARNESS_VALUES: readonly Harness[] = ["claude", "codex"];
export const harnessOf = (agent: { harness?: Harness }): Harness => agent.harness ?? "claude";

export type Agent = {
  id: string;
  // B6: null 이면 폴더 없는 세션(퀵 챗). 사이드바 Chats 묶음에 들어가고 cwd 는 서버가 만든 임시 폴더다(git 없음).
  workspaceId: string | null;
  // 세션이 실제로 도는 폴더. worktree 세션이면 worktree 안의 같은 하위 경로.
  cwd: string;
  worktree: Worktree | null;
  // 갈래 세션: 원 세션 id. resumeFrom 이 남아 있으면 첫 턴에서 forkSession 으로 갈라진다.
  forkedFrom: string | null;
  // 곁다리 질문 창(/btw)에서 "Open as Session" 으로 옮긴 세션. 다음 턴 하나에 "읽기 전용 제한이 풀렸다" 는 안내를 모델에게만 붙이고 지운다(server/agents.ts startTurn).
  sideAdopted?: boolean;
  resumeFrom: string | null;
  // 세션 시작 시점의 HEAD. worktree 가 아닌 세션의 변경 기준.
  startCommit: string | null;
  // 갈래 세션이 갈래를 만든 시점의 작업 폴더 상태를 Session 범위의 기준으로 갖고 있다(server/forkBase.ts). 없으면 옛 계산을 쓴다.
  forkBased?: boolean;
  // 피드백 개선 세션이면 그 피드백 id. 사이드바 맨 위 "agent-nav 개선" 묶음에 보인다.
  feedbackId: string | null;
  title: string;
  sessionId: string | null;
  status: AgentStatus;
  permissionMode: PermissionMode;
  model: string | null;
  effort: EffortLevel | null;
  activeModel: string | null;
  activeEffort: EffortLevel | null;
  backgroundTasks: number;
  createdAt: string;
  updatedAt: string;
  // B1: 사이드바 세션 목록 상태. 없으면 false. updatedAt 은 모델 바꾸기 같은 설정 변경에도 올라가서 "안 읽음" 판단에 쓸 수 없어 따로 둔다.
  // 턴이 끝나면 서버가 unread 를 올리고, 웹이 그 세션을 보고 있으면 agents.markRead 로 내린다.
  unread?: boolean;
  pinned?: boolean;
  done?: boolean;
  // AUTODONE: 사용자가 Done 을 직접 푼 시각. 자동 Done 은 updatedAt 과 이 값 중 늦은 쪽부터 3일을 센다(푼 세션이 다음 정리에서 바로 다시 Done 이 되지 않게).
  reopenedAt?: string;
  // B2: 체크포인트를 복원한 뒤 다음 턴이 이어 갈 대화 위치(세션 기록의 마지막 유지 항목 uuid). 다음 턴의 init 이 오면 지운다.
  resumeAt?: string | null;
  // B3: 응답 중에 보내서 줄을 선 메시지. 턴이 정상으로 끝나면 서버가 맨 앞 것부터 보낸다. 중단이나 오류로 끝나면 그대로 남는다.
  queue?: QueuedMessage[];
  steering?: QueuedMessage[];
  imported?: ImportedFrom;
  // CTX: 이 세션의 컨텍스트 창 사용량. 마지막으로 안 값이라 프로세스가 없어도 남는다. 없으면 아직 한 번도 못 쟀다.
  contextUsage?: ContextUsage | null;
  // HANDOFF: 핸드오프로 시작한 세션이면 원 세션 id. 사이드바에서 원 세션 아래 자식으로 붙는다(갈래와 같은 트리).
  handoffFrom?: string | null;
  // LINEAR: 이 세션이 다루는 Linear 이슈. 이슈에서 시작했거나 나중에 이은 세션만 갖는다(agents.setLinearIssue).
  linearIssue?: LinearIssueRef | null;
  // CODEX: 세션을 돌리는 도구. 없으면 claude. codex 세션은 sessionId 를 쓰지 않고 codexThreadId 로 앱 서버의 스레드를 이어 간다.
  harness?: Harness;
  // CODEX: 앱 서버 스레드 id. 첫 턴이 시작될 때 채워진다. 데몬이 다시 떠도 이 id 로 thread/resume 해서 이어 간다.
  codexThreadId?: string | null;
};

// CTX: used 는 컨텍스트에 들어 있는 토큰, limit 은 자동 압축 기준 창 크기(SDK getContextUsage 의 rawMaxTokens). 비율은 used / limit 으로 화면이 계산한다.
// source 가 api 면 SDK 가 알려 준 값, estimate 면 응답 프레임의 usage 로 어림한 값이다(턴이 끝나면 api 값으로 바뀐다).
export type ContextUsage = { used: number; limit: number; source: "api" | "estimate"; at: string };

// B3: 큐에 선 메시지 하나
// DIFFFB: shown 과 attachments 는 큐와 끼어들기를 거쳐도 말풍선에 보일 글과 칩을 지키는 필드다(text 는 모델에 가는 프롬프트). feedback 은 이 메시지에 묶인 피드백이라 큐에서 빼면 다시 쌓인 상태로 돌아간다.
// QUEUECANCEL: sent 는 끼어들기 취소를 시도했는데 CLI 가 이미 그 메시지를 넘겨받은 뒤였다는 표지(Already sent to Claude). 화면이 취소 단추 대신 안내를 보인다.
export type QueuedMessage = { id: string; text: string; shown?: string; attachments?: UserAttachment[]; feedback?: DiffFeedback[]; sent?: boolean };

// B2: files 는 파일과 대화를 함께 되돌림, chat 은 파일 스냅샷이 없어 대화만 되돌림, none 은 세션 기록에서 그 메시지를 찾지 못해 복원 불가.
export type CheckpointMode = "files" | "chat" | "none";

// FBFIX: 사용자 메시지에 붙은 첨부 칩. 피드백에서 고른 화면 요소. path 는 그 세션 작업 폴더 기준 상대 경로, 모르면 null.
// DIFFFB: kind "diffFeedback" 는 diff 줄에 쌓은 피드백 칩이다. label 은 `파일:줄 범위`, path 는 절대 경로, line 은 시작 줄, endLine 은 끝 줄, id 는 쌓아 둔 피드백 id(칩을 누르면 그 위치와 글을 다시 보인다).
export type UserAttachment =
  | { kind: "element"; label: string; path: string | null; line: number | null }
  // FBNOEL: 피드백에 붙은 창 스크린샷. thumb 은 말풍선 위 칩에 보일 작은 JPEG data URL 이다.
  | { kind: "screenshot"; label: string; thumb: string }
  | { kind: "diffFeedback"; label: string; path: string; line: number; endLine: number; id: string; text: string }
  // HANDOFF: 핸드오프로 시작한 세션의 첫 메시지에 붙는 인계 문서 칩. id 는 ~/.agent-nav/handoffs/<id>.md, 누르면 문서 전문을 본다.
  | { kind: "handoff"; label: string; id: string }
  // fixB: 입력창에 붙여 보낸 이미지. id 는 ~/.agent-nav/images/<id>.<확장자>(모델에는 이 파일을 image 블록으로 보낸다), thumb 은 말풍선 위 칩에 보일 작은 JPEG data URL 이다.
  | { kind: "image"; label: string; id: string; thumb: string }
  // FILEATTACH: 입력창에 붙여 보낸 이미지가 아닌 파일. 내용은 모델에 가지 않고 path(절대 경로)가 메시지 끝의 첨부 파일 블록에 실려 에이전트가 직접 연다. label 은 파일 이름, bytes 는 보낼 때 잰 크기.
  | { kind: "file"; label: string; path: string; bytes: number }
  // NOTION2: 페이지 전용 대화의 첫 메시지에 붙는 Notion 페이지 칩. 누르면 그 페이지의 Notion 화면으로 간다.
  | { kind: "notion"; label: string; url: string };

// SUB: 서브에이전트 하나의 현황. SDK 의 task_started, task_progress, task_updated, task_notification 과 Agent 호출의 결과를 모은 값이다.
// activity 는 task_progress 의 한 줄 설명(예: "Reading a.txt"), summary 는 끝난 뒤 결과의 첫 줄이다.
export type SubagentStatus = "running" | "completed" | "failed" | "stopped";
export type SubagentTask = {
  taskId: string | null;
  status: SubagentStatus;
  backgrounded: boolean;
  subagentType: string | null;
  description: string;
  activity: string | null;
  tokens: number;
  toolUses: number;
  durationMs: number;
  lastTool: string | null;
  summary: string | null;
  startedAt: string;
  endedAt?: string;
};

export type DiffFeedback = {
  id: string;
  path: string;
  rel: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
  codeSelection?: string;
  diffHunks?: string;
  state: "accepted" | "submitted";
  createdAt: string;
};

// INLINEMEDIA: media.resolve 가 읽을 수 있다고 답한 파일. url 은 데몬 주소(/media?...)이고 서명이 들어 있어 이 파일 하나만 읽힌다.
export type MediaInfo = { raw: string; kind: "image" | "video"; mime: string; size: number; name: string; url: string };

export type TimelineItem =
  // B2: at 은 서버가 항목을 만든 시각(ISO), messageId 는 이 턴을 SDK 에 보낼 때 정한 사용자 메시지 uuid(체크포인트가 켜진 턴에만 있다. 이 uuid 로 rewindFiles 를 부른다).
  // FBFIX: shown 과 attachments 는 화면용이다. text 는 모델에 간 프롬프트 그대로이고, 말풍선에는 shown 이 있으면 shown 만, 첨부는 칩으로 보인다.
  | { id: string; kind: "user"; text: string; source?: "user" | "system"; at?: string; messageId?: string; shown?: string; attachments?: UserAttachment[]; preCompact?: boolean }
  // B2: model 은 응답이 실제로 쓴 모델 id
  | { id: string; kind: "assistant"; text: string; streaming: boolean; at?: string; model?: string }
  | { id: string; kind: "thinking"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      status: "running" | "done" | "error";
      output: string | null;
      // B2: 사용자가 중단해서 끝나지 못한 호출
      cancelled?: boolean;
      // G8: Browser 도구 호출이 가리킨 페이지(호출 시점의 제목과 주소)와 스크린샷 파일 경로(타임라인 썸네일)
      page?: { title: string; url: string };
      shots?: string[];
      // SUB: Agent(Task) 도구 호출이 띄운 서브에이전트의 현황. 호출 항목 하나가 서브에이전트 하나이고 id 가 곧 tool_use_id 다.
      task?: SubagentTask;
      // SUB: 서브에이전트가 부른 도구면 그 서브에이전트를 띄운 Agent 호출의 id. 이 항목은 대화의 단계 목록이 아니라 그 Agent 행 안에 보인다.
      parentToolUseId?: string;
    }
  | {
      id: string;
      kind: "permission";
      // 이 승인이 가리키는 도구 호출(tool 항목의 id). 타임라인에서 두 항목을 한 줄로 합칠 때 쓴다.
      toolUseId?: string;
      toolName: string;
      input: Record<string, unknown>;
      status: "pending" | "allowed" | "denied";
      // fixB: 질문(AskUserQuestion)과 계획 승인(ExitPlanMode)에서 사용자가 고른 것. 답한 뒤에도 카드 대신 대화에 그대로 보인다.
      outcome?: PermissionOutcome;
      // NOTION2: Notion 쓰기 제안(notion_update_page, notion_create_pages)의 미리보기. 승인 카드가 diff 로 그린다. 처리한 뒤에도 무엇을 승인했는지 남는다.
      notion?: NotionWritePreview;
      // NOTION3: 카드 없이 바로 반영한 Notion 쓰기(Bypass Permissions). 대화에 "Applied to Notion" 기록 줄로 남는다.
      auto?: boolean;
    }
  // B2: changes 는 그 턴이 바꾼 파일 요약(Last Turn Changes 기준). 변경이 없으면 없다.
  // CODEX: tokens 는 Codex 턴이 쓴 토큰 합(Codex 는 비용을 주지 않는다). 있으면 비용 대신 보인다.
  | { id: string; kind: "result"; isError: boolean; durationMs: number; costUsd: number | null; changes?: TurnChanges; tokens?: number }
  // B2: 체크포인트를 복원한 자리. redoable 이 true 인 동안 Redo 로 복원 전으로 돌아갈 수 있다. chatOnly 는 파일 스냅샷이 없어 대화만 되돌린 복원이다.
  | { id: string; kind: "restored"; redoable: boolean; chatOnly?: boolean }
  // FBFIX: detail 은 긴 출력(검사 로그 등). 대화에서 본문이 아니라 고정폭 상자로 보인다.
  // IMPORT: divider 는 가져온 세션의 압축 지점(문구 옆에 줄을 그린다). user 항목의 preCompact 는 마지막 압축 이전의 메시지로, 읽기 전용이라 체크포인트 복원과 갈래를 쓰지 않는다.
  // HANDOFF: openAgentId 가 있으면 그 줄을 눌러 해당 세션으로 간다("Handed off to ...").
  | { id: string; kind: "notice"; text: string; detail?: string; fold?: { label: string; text: string }; divider?: boolean; openAgentId?: string }
  | { id: string; kind: "error"; text: string; auth: boolean };

// list 는 그 턴이 바꾼 파일(절대 경로). 이 필드를 넣기 전에 저장된 턴에는 없다.
export type TurnChangedFile = { path: string; additions: number; deletions: number };
export type TurnChanges = { files: number; additions: number; deletions: number; list?: TurnChangedFile[] };

export type PermissionDecision = "allow" | "allowAlways" | "deny";

// fixB: AskUserQuestion 의 답(질문 글 -> 고른 선택지 label, 여러 개는 ", " 로 이음, "기타" 는 사용자가 쓴 글)과 ExitPlanMode 의 결정.
// approved 는 계획대로 진행(mode 는 그 뒤의 권한 모드), kept 는 계속 계획(feedback 은 모델에 간 사용자 글).
export type PermissionOutcome = {
  answers?: Record<string, string>;
  plan?: { decision: "approved"; mode: PermissionMode } | { decision: "kept"; feedback?: string };
};

// fixB: 입력창에서 보낸 이미지 하나. images.upload 가 돌려준 id 와 말풍선 칩에 쓸 이름, 작은 썸네일.
export type ImageRef = { id: string; label: string; thumb: string };

// FILEATTACH: 입력창에서 보낸 파일 하나. path 는 Finder 에서 놓은 파일의 원래 경로이거나 업로드 폴백이 저장한 ~/.agent-nav/attachments/<id>/<이름> 이다. 데몬이 보내는 시점에 파일이 있는지, 크기가 얼마인지 다시 본다.
export type FileRef = { path: string; name: string; bytes: number; mediaType: string };

export type ModelInfo = {
  value: string;
  resolvedModel: string | null;
  displayName: string;
  supportedEffortLevels: EffortLevel[];
};

// CODEX: Codex 앱 서버가 알려 주는 모델. supportedEffortLevels 는 Lodestar 가 고를 수 있는 effort 와의 교집합이다(ultra 처럼 EffortLevel 에 없는 값은 뺀다).
export type CodexModelInfo = { value: string; displayName: string; description: string; isDefault: boolean; supportedEffortLevels: EffortLevel[]; defaultEffort: EffortLevel | null };

// CODEX: 입력창 칩과 새 세션 화면이 쓰는 Codex 쪽 정보. 로그인은 Codex 가 쓰는 기존 로그인(~/.codex)을 그대로 쓰고 토큰은 읽지 않는다.
// defaultModel 과 defaultEffort 는 ~/.codex/config.toml 의 값이라 models 목록에 없을 수 있다.
export type CodexMeta = {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  account: { type: "chatgpt" | "apiKey" | "other"; plan: string | null } | null;
  models: CodexModelInfo[];
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
  error: string | null;
  fetchedAt: string;
};

// status 는 SDK 가 주는 connected, failed, needs-auth, pending, disabled 중 하나다 (모르는 값이 와도 그대로 보인다).
// error 는 failed 일 때 CLI 가 주는 사유, toolCount 는 연결돼 있을 때만 있다.
// tools 는 연결돼 있을 때 서버가 알려 주는 도구 이름과 설명(옛 데몬이면 없다).
export type McpStatus = { name: string; status: string; source: string | null; error: string | null; toolCount: number | null; tools?: { name: string; description: string | null }[] };

// 재연결과 켜기/끄기의 결과. 서버가 응답하지 않거나 인증이 필요해서 실패해도 예외가 아니라 ok: false 로 오고, meta 는 그 뒤에 다시 읽은 상태다.
// sessions 는 지금 턴이 도는 세션 쪽 결과다 (대기 중인 세션은 CLI 프로세스가 없어서 다음 턴에 새로 읽는다).
export type McpSessionResult = { reconnected: number; failed: number; skipped: number };
export type McpActionResult = { ok: boolean; error: string | null; sessions: McpSessionResult; meta: Meta };

// B3: 슬래시 명령 하나. 설명이 길면 화면에서 한 줄로 잘린다.
export type CommandInfo = { name: string; description: string };

export type Meta = {
  claudeVersion: string | null;
  account: { email: string; subscriptionType: string } | null;
  models: ModelInfo[];
  mcp: McpStatus[];
  commandCount: number;
  // B3: `/` 메뉴에 보이는 스킬과 명령(이름은 슬래시 없이). 옛 데몬이나 옛 캐시에는 없다.
  commands?: CommandInfo[];
  fetchedAt: string | null;
  error: string | null;
  claudeMissing?: boolean;
};

// 데몬이 어느 빌드로 떠 있는지. repo 는 소스 폴더의 빌드 결과, bundle 은 앱 번들 안의 것.
export type RuntimeInfo = { kind: "repo" | "bundle"; root: string; note: string | null };

// black 은 다크 토큰 위에 바탕만 더 검게 덮는 별도 테마다(<html data-theme="dark" data-black="true">, web/styles.css).
export type Theme = "dark" | "light" | "system" | "black";

// 색 스타일. Theme 가 밝기(Dark, Light, System)를 정하고 스타일이 팔레트를 정한다. webstorm 은 JetBrains New UI 색(design-system/webstorm-theme.md).
export const THEME_STYLES = ["lodestar", "webstorm"] as const;
export type ThemeStyle = (typeof THEME_STYLES)[number];

export const DIFF_VIEWS = ["inline", "split", "auto"] as const;
export type DiffView = (typeof DIFF_VIEWS)[number];

export const KEYMAP_PRESETS = ["vscode", "webstorm"] as const;
export type KeymapPreset = (typeof KEYMAP_PRESETS)[number];
export type CommandKeys = Record<string, string[]>;
export type KeymapOverrides = Partial<Record<KeymapPreset, CommandKeys>>;

export const BROWSER_SEARCH_ENGINES = ["bing", "google", "duckduckgo", "yahoo", "none"] as const;
export type BrowserSearchEngine = (typeof BROWSER_SEARCH_ENGINES)[number];
export const BROWSER_PAGE_ZOOMS = [50, 75, 100, 125, 150, 200] as const;
export const BROWSER_STORAGES = ["default", "global", "workspace", "ephemeral", "agent"] as const;
export type BrowserStorage = (typeof BROWSER_STORAGES)[number];
export const BROWSER_TITLE_BAR = [true, false, "whenOpen"] as const;
export type BrowserTitleBar = (typeof BROWSER_TITLE_BAR)[number];

export type Settings = {
  // 설정 파일 형식 버전. 2 부터 위 기본값이 "고른 값만" 담긴다 (옛 파일은 데몬이 읽을 때 한 번 옮긴다).
  settingsVersion: number;
  theme: Theme;
  themeStyle: ThemeStyle;
  defaultPermissionMode: PermissionMode | null;
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
  diffInlineWhenNarrow: boolean | null;
  requestQueuing: RequestQueuing | null;
  previewEditors: boolean | null;
  revealIfOpen: boolean;
  quickOpenIncludeExcluded: boolean;
  editorOptions: Partial<EditorOptions>;
  quickModel: string;
  // QUICKENTRY: 어느 앱에서나 단축키로 띄우는 빠른 입력창(electron/quickEntry.ts). 단축키는 Electron accelerator 문자열(shared/quickEntry.ts 가 검증)이고 기본은 Alt+C 다.
  quickEntryEnabled: boolean;
  quickEntryShortcut: string;
  // MINICHAT: 미니 채팅 패널의 대화 화면에서 바깥을 누르면 숨길지. 꺼져 있으면(기본) 패널이 고정이라 숨기지 않는다. 입력 막대는 늘 숨는다.
  miniChatHideOnBlur: boolean;
  // 코드 글꼴 (에디터, diff, 대화 속 코드, 빠른 질문 창). UI 글꼴은 건드리지 않는다.
  editorFontFamily: string;
  editorFontSize: number;
  editorLineHeight: number;
  editorLigatures: boolean;
  // 켜져 있으면 터미널(xterm)도 같은 글꼴 설정을 쓴다.
  editorFontTerminal: boolean;
  // UI 글자 (고정폭 글꼴 영역은 자간 0 으로 제외). 대화 본문은 사용자 말풍선과 응답 마크다운.
  uiLetterSpacing: number;
  uiFontFamily: string;
  chatFontSize: number;
  chatLineHeight: number;
  // Slack(멘션 Inbox)과 Board 화면을 사이드바, 단축키, 명령 팔레트, 메뉴에 보일지. 기본값은 둘 다 꺼짐이다.
  // showSlack 이 꺼져 있으면 데몬도 Slack 멘션을 가져오지 않고 판단과 분석 모델도 부르지 않는다. 가져온 항목은 지우지 않아 다시 켜면 그대로 돌아온다.
  // showBoard 가 꺼져 있으면 Board 화면과 아침 리뷰 자동 실행만 멈춘다. 카드 데이터와 세션과 카드의 연결은 그대로다.
  showSlack: boolean;
  showBoard: boolean;
  // 보드 카드에 연결된 세션의 상태로 카드를 자동으로 옮긴다 (첫 실행 In Progress, 변경이 남은 채 턴 종료 Review).
  boardAutoMove: boolean;
  // MORNINGREVIEW: 평일 아침 설정 시각에 보드와 세션을 훑어 짧은 리뷰를 만든다(HH:MM, 데몬의 로컬 시각). 그 시각에 앱이 꺼져 있었으면 그날 처음 뜰 때 한 번 만든다.
  morningReviewEnabled: boolean;
  morningReviewTime: string;
  notifyOnResponse: boolean;
  notifyOnApproval: boolean;
  // RELEASE: 하루 한 번 GitHub 의 최신 릴리스를 묻고 새 버전이 있으면 사이드바 아래에 한 줄로 알린다(server/releaseCheck.ts). 기본 꺼짐이고, 꺼져 있으면 요청을 보내지 않는다.
  notifyNewVersion?: boolean;
  useProviderEnv?: boolean;
  // Slack Inbox 를 몇 분마다 가져올지. 0 이면 끔 (수동 새로 고침만). 화면은 끔/5/10/30 을 고르고, 데몬은 0~120 의 정수를 받는다.
  inboxIntervalMinutes: number;
  // FIX3-7: 응답이 끝난 세션의 claude 프로세스를 입력 없이 몇 분 들고 있을지. 지나면 프로세스를 닫고, 다음 메시지가 같은 세션 id 로 resume 한다(첫 응답이 조금 늦다).
  // 칸에 열려 있는 세션과 백그라운드 작업이 도는 세션은 세지 않는다. 0 이면 닫지 않는다. 데몬은 0~1440 의 정수를 받는다.
  keepIdleSessionsWarmMinutes: number;
  // PERFDAEMON: 쉬는 세션의 claude 프로세스를 최대 몇 개까지 데워 둘지. 넘으면 가장 오래전에 쓴 쉬는 세션부터 닫는다(칸에 열려 있어도). 0 이면 한도 없음. 데몬은 0~50 의 정수를 받는다.
  maxWarmSessions: number;
  // PERFDAEMON: 켜면 데몬이 뜬 뒤와 6시간마다 끝난 피드백의 worktree 와 되돌리기 백업을 정리한다(shared/feedbackRetention.ts 의 기본 보존 규칙). 진행 중이거나 다시 돌릴 수 있는 피드백은 건드리지 않는다.
  feedbackAutoTidy: boolean;
  // 자리를 비운 사이(입력 10분 없음, 도는 세션 없음) 새 소스가 있으면 앱이 스스로 빌드하고 설치한 앱을 갈아 끼운다(server/idleUpdate.ts). 기본 켜짐.
  autoUpdateWhenIdle: boolean;
  // Slack 멘션이 작업 요청이면 분석한 뒤 보드 Todo 열에 카드로 자동 추가한다. 끄면 새 멘션을 판단하지도, 분석하지도 않는다.
  autoAddRequests: boolean;
  // 요청으로 판단된 멘션을 분석(스레드와 노션 링크 읽기, 코드 찾기)하는 모델
  mentionAnalysisModel: string;
  // 분석 한 번의 비용 상한(USD). null 이면 모델별 기본값(server/mentionAnalyze.ts 의 ANALYSIS_BUDGET_USD).
  mentionAnalysisBudgetUsd: number | null;
  // slack:// 링크에 쓸 워크스페이스 ID (T 로 시작). 가져온 결과에 없어서 사용자가 넣는다. 비어 있으면 https 링크만 쓴다.
  slackTeamId: string;
  // 앱 안에서 누른 Slack 메시지 링크를 여는 곳. "app" 은 Slack 데스크톱 앱(slack://, 워크스페이스 ID 가 있을 때만), "browser" 는 기본 브라우저.
  slackLinkTarget: SlackLinkTarget;
  // 앱 안에서 누른 Notion 링크를 여는 곳. "lodestar" 는 앱 안 Notion 화면(기본), "app" 은 Lodestar 의 Browser 탭(이미 열려 있으면 그 탭), "notion" 은 Notion 데스크톱 앱(notion://), "browser" 는 기본 브라우저.
  notionLinkTarget: NotionLinkTarget;
  // NOTION3: 권한 모드가 Bypass Permissions 일 때 Notion 쓰기를 어떻게 받을지. "apply" 는 카드 없이 바로 반영하고 대화에 기록 줄을 남긴다(기본). "ask" 는 모드와 상관없이 승인 카드를 거친다.
  notionBypassWrites: NotionBypassWrites;
  // ASIDEVIEW: 세션의 Bash 가 사용자의 포커스와 입력을 뺏지 않게 막는다. `open` 에는 -g 를 붙이고, osascript 의 activate 와 System Events 입력은 거절한다. 기본 켬.
  focusGuard: boolean;
  // diff 기본 보기. 변경 패널과 diff 탭의 Inline / Split 전환이 바로 이 값을 바꾼다 (마지막 선택이 곧 기본값).
  diffView: DiffView;
  // 단축키 프리셋. Electron 메인도 settings.json 에서 직접 읽어 가로챌 키와 메뉴 가속키를 정한다.
  keymapPreset: KeymapPreset;
  keymapOverrides?: KeymapOverrides;
  activityBar?: ActivityBarPrefs;
  browserSearchEngine: BrowserSearchEngine;
  browserMaxHistory: number;
  browserChatTools: boolean;
  browserPageZoom: number | null;
  browserAttachElementImage: boolean;
  browserOpenLocalhostLinks: boolean;
  // G8: 나머지 Browser 설정. Remote Proxy 와 New Tab Placement 는 이 앱 구조에서 값이 하나뿐이라 설정이 아니라 설정 화면의 고정 표시다.
  browserDataStorage: BrowserStorage;
  browserAutoReload: boolean;
  browserShowInTitleBar: BrowserTitleBar;
  browserUserTools: boolean;
  formatOnSave: boolean | null;
  formatters: Record<string, FormatterId>;
  // FLOAT: 배치. Default Layout 은 앱을 열 때의 배치(chat: 대화 격자가 가운데, editor: 에디터 그룹이 가운데이고 대화는 떠 있는 창). null 이면 chat.
  // rememberLastLayout 이 켜져 있으면 쓰는 중 마지막으로 바꾼 배치로 시작한다(기본 끔).
  defaultLayout: "chat" | "editor" | null;
  rememberLastLayout: boolean;
  // PERLAYOUT: 켜져 있으면(기본) 세션마다 배치(Chat, Editor 중심, 떠 있는 창, 사이드바, 오른쪽, 아래 패널)를 기억해 그 세션으로 돌아오면 되살린다. 끄면 전역 배치 하나.
  rememberLayoutPerSession: boolean;
  // STEPSFOLD: 대화의 작업 묶음(Working, Finished with N steps)을 펼쳐 둘지. 끄면(기본) 접힌 채로 두고, 사용자가 연 묶음만 열린다.
  expandSteps: boolean;
  // FILESPIN: Chat 중심에서 에디터 탭이 열려 있을 때 Changes, Files 고정 칸이 에디터의 어느 쪽에 붙는지. null 이면 right.
  pinnedPanelSide: "left" | "right" | null;
  // FOCUS: Editor 중심 배치에서 대화가 놓이는 방식. docked 는 오른쪽 고정 패널(Secondary Side Bar), floating 은 떠 있는 창. null 이면 docked.
  chatInEditorLayout: "docked" | "floating" | null;
  // MOBILE: 같은 네트워크의 iOS 앱(mobile/)이 붙는 별도 포트를 연다. 기본 꺼짐. 켜면 페어링한 장치의 토큰으로만 붙고, 허용한 RPC 만 쓴다(server/mobileAccess.ts).
  mobileAccess: boolean;
};

export type DefaultSource = "agent-nav" | "vscode" | "claude" | "builtin";
export type Resolved<T> = { value: T; source: DefaultSource };
export type SessionSort = "created" | "updated";

// 고른 값이 없을 때 실제로 쓰이는 기본값. 데몬이 settings.get 과 같은 때 다시 읽는다.
export type ResolvedDefaults = {
  // null 이면 어디에도 지정이 없어 CLI 가 정한다
  model: Resolved<string | null>;
  effort: Resolved<EffortLevel | null>;
  permissionMode: Resolved<PermissionMode>;
  diffInlineWhenNarrow: Resolved<boolean>;
  sessionSort: Resolved<SessionSort>;
  requestQueuing: Resolved<RequestQueuing>;
  previewEditors: Resolved<boolean>;
  editorOptions?: ResolvedEditorOptions;
};

export type RequestQueuing = "queue" | "steer";

// 코드 글꼴 기본값. 서버(저장 기본값)와 웹(옛 데몬이 필드를 안 줄 때)이 같이 쓴다.
export const EDITOR_FONT_DEFAULTS = {
  editorFontFamily: '"D2Coding ligature", "D2Coding", "Geist Mono", monospace',
  editorFontSize: 12.5,
  editorLineHeight: 20,
  editorLigatures: true,
  editorFontTerminal: true,
} satisfies Pick<Settings, "editorFontFamily" | "editorFontSize" | "editorLineHeight" | "editorLigatures" | "editorFontTerminal">;

// UI 글자 기본값과 허용 범위. 기본값은 web/tokens.css 의 --font-sans, --text-chat, --leading-chat 와 같고 자간은 body 의 -0.02em 이다.
export const UI_TYPE_DEFAULTS = {
  uiLetterSpacing: -0.02,
  uiFontFamily: '-apple-system, "system-ui", sans-serif',
  chatFontSize: 13,
  chatLineHeight: 19.5,
} satisfies Pick<Settings, "uiLetterSpacing" | "uiFontFamily" | "chatFontSize" | "chatLineHeight">;
export const UI_TYPE_RANGES = {
  uiLetterSpacing: { min: -0.05, max: 0.05 },
  chatFontSize: { min: 10, max: 24 },
  chatLineHeight: { min: 14, max: 40 },
} as const;

// --- Slack Inbox (~/.agent-nav/inbox.json) ---

export type InboxKind = "mention" | "dm" | "thread";

export type InboxItem = {
  // `${channelId}:${ts}`. 같은 메시지를 다시 가져와도 하나로 합쳐진다.
  id: string;
  kind: InboxKind;
  channelId: string;
  // "#name" 이나 "DM"
  channelName: string;
  // Slack 메시지 ts (예: "1791974742.663289")
  ts: string;
  // 스레드의 답글이면 부모 ts
  threadTs: string | null;
  from: { id: string; name: string };
  text: string;
  // https 퍼머링크
  permalink: string;
  // ts 에서 계산한 ISO 시각
  time: string;
  read: boolean;
  archived: boolean;
  fetchedAt: string;
  // 요청 판단 결과. 없으면 아직 판단 전이다 (판단은 새 멘션마다 한 번만 한다).
  judgment?: MentionJudgment;
  // 판단 호출이 실패한 횟수. 3번 실패하면 더 부르지 않고 judgment.skipped 를 "failed" 로 둔다.
  judgeFailures?: number;
  // 이 멘션으로 만든 보드 카드 (자동이든 수동이든). 카드를 사람이 지워도 그대로 남겨서 같은 멘션으로 카드를 다시 만들지 않는다.
  cardId?: string | null;
  // 분석 큐의 상태 (요청으로 판단된 멘션만). 분석이 끝나면 카드가 만들어진다.
  analysis?: MentionAnalysis;
  // 사용자가 직접 정한 판정. "Not a request" 를 누르면 not-request 가 되고, 카드를 만들면 지워진다.
  verdict?: "not-request";
  // inbox.thread 로 읽어 온 스레드 (읽기 전에는 없다). 첫 메시지가 스레드의 부모다.
  thread?: { fetchedAt: string; messages: InboxThreadMessage[] };
  // v1 시절(참여한 스레드 답글을 모두 가져오던 때)에 가져온 thread 항목. 파일에만 남고 화면에 나오지 않는다 (저장 v3 마이그레이션이 붙인다).
  // 같은 메시지를 새 가져오기가 다시 읽으면 지워진다.
  legacy?: true;
};

// 멘션이 작업 요청인지 haiku 가 판단한 결과. skipped 가 있으면 판단하지 않은 항목이다.
//  - legacy: 이 기능 이전에 가져온 항목
//  - off: "Auto-add requests to Board" 가 꺼진 동안 들어온 항목
//  - failed: 판단 호출이 3번 실패한 항목
export type MentionJudgment = {
  at: string;
  skipped?: "legacy" | "off" | "failed";
  isRequest: boolean;
  // 0 에서 1
  confidence: number;
  // 할 일 형태의 짧은 제목 (메시지 언어)
  title: string;
  // 1~2줄 요약
  summary: string;
};

export type MentionAnalysisStatus = "queued" | "running" | "done" | "failed";

export type MentionAnalysis = {
  status: MentionAnalysisStatus;
  // 마지막으로 상태가 바뀐 시각
  at: string;
  // 사용자가 Re-analyze 로 시킨 분석. 자동 분석이 꺼져 있어도 돈다.
  manual?: boolean;
  model?: string;
  costUsd?: number | null;
  turns?: number | null;
  // 분석 중 실제로 호출된 도구 이름 (쓰기 도구가 없다는 증거). 도구 입력과 결과는 남기지 않는다.
  tools?: string[];
  // 실패 이유 (비용 상한, 턴 상한, 시간 초과, 출력 형식 오류 등)
  error?: string | null;
  // 결과 개수. 내용은 카드에만 있다.
  stats?: { steps: number; files: number; questions: number; links: number };
};

export type InboxThreadMessage = { ts: string; from: { id: string; name: string }; text: string };

export type InboxFetchInfo = {
  at: string;
  // 이번에 읽은 항목 수. 종류별이고, 본인이 쓴 글과 이번 가져오기 안의 중복은 뺀 값이다.
  counts: Record<InboxKind, number>;
  // 이번에 새로 들어온 항목 수
  added: number;
  // 검색 한 번에 20건이 한도라 더 있을 수 있음
  partial: boolean;
  error: string | null;
  // 이번 가져오기가 쓴 Slack 도구 이름 (쓰기 도구가 없다는 증거)
  tools: string[];
  costUsd: number | null;
  turns: number | null;
  // 이번 가져오기에서 한 요청 판단. 옛 데이터에는 없다.
  judge?: JudgeInfo;
};

export type JudgeInfo = {
  // 판단한 멘션 수와 그 결과
  judged: number;
  requests: number;
  notRequests: number;
  // 분석 큐에 넣은 수 (isRequest 이고 confidence 가 기준 이상). 카드는 분석이 끝나면 만들어진다.
  queued: number;
  error: string | null;
  costUsd: number | null;
  turns: number | null;
};

export type InboxState = {
  selfUserId: string | null;
  lastFetchedAt: string | null;
  items: InboxItem[];
  lastFetch: InboxFetchInfo | null;
  fetching: boolean;
  unread: number;
};

// --- 칸반 보드 (~/.agent-nav/board.json) ---

// 자동 이동 규칙이 가리키는 열의 역할. 열 이름은 바꿔도 역할은 그대로라 규칙이 계속 동작한다. 사용자가 만든 열은 role 이 null.
export type BoardRole = "backlog" | "todo" | "inProgress" | "review" | "done";

export type BoardColumn = { id: string; name: string; role: BoardRole | null };

// BOARDUX: 우선순위. 0 없음, 1 Urgent, 2 High, 3 Medium, 4 Low (Linear 와 같은 번호). 숫자가 작을수록 급하다.
export type BoardPriority = 0 | 1 | 2 | 3 | 4;

// BOARDUX: 열 안 정렬. manual 은 끌어서 정한 배열 순서 그대로, priority 는 급한 순(같으면 배열 순서), updated 는 최근 수정이 위.
export type BoardSort = "manual" | "priority" | "updated";

// 외부 링크 (Slack 메시지, PR 등). url 은 http 또는 https 만 받는다.
export type CardLink = { url: string; title: string | null };

// TOBOARD: 카드를 만든 대화 위치. itemId 는 세션 타임라인 항목 id, part 는 선택한 글이나 할 일의 지문(항목 전체면 null).
export type CardSource = { agentId: string; itemId: string; part: string | null };

export type BoardCard = {
  id: string;
  columnId: string;
  title: string;
  // 마크다운
  body: string;
  labels: string[];
  // BOARDUX: 우선순위(0 이면 없음)와 보드 안 일련번호(LOD-12 의 12). 번호는 서버가 매기고 바뀌지 않으며 지운 번호는 다시 쓰지 않는다.
  priority: BoardPriority;
  number: number;
  // 연결된 워크스페이스 (사이드바의 프로젝트 단위. worktree 워크스페이스가 아니라 원래 프로젝트)
  workspaceId: string | null;
  agentIds: string[];
  links: CardLink[];
  // TOBOARD: 대화의 한 부분에서 만든 카드만 갖는다. 없거나 null 이면 대화와 무관하게 만든 카드.
  source?: CardSource | null;
  createdAt: string;
  updatedAt: string;
};

// cards 는 열 순서대로 묶여 있고, 한 열 안의 순서는 배열 순서다.
// nextNumber 는 다음 카드가 받을 번호. labelColors 는 사용자가 라벨 색을 바꾼 것만 담는다(키는 소문자 라벨, 값은 팔레트 번호).
export type Board = { columns: BoardColumn[]; cards: BoardCard[]; nextNumber: number; labelColors: Record<string, number> };

export type NewCard = {
  title: string;
  body?: string;
  labels?: string[];
  links?: CardLink[];
  workspaceId?: string | null;
  agentIds?: string[];
  source?: CardSource | null;
  // 없으면 0
  priority?: BoardPriority;
  // 없으면 첫 번째 열
  columnId?: string;
};

export type CardPatch = {
  title?: string;
  body?: string;
  labels?: string[];
  links?: CardLink[];
  workspaceId?: string | null;
  priority?: BoardPriority;
};

// FIX4A: Undo 가 건너뛴 파일과 이유. modified 는 에이전트의 마지막 쓰기 뒤 디스크가 바뀜, mixed 는 다른 손의 변경 위에 에이전트가 또 씀, unknown 은 옛 세션이라 마지막 쓰기를 모름.
export type UndoSkip = { path: string; reason: "modified" | "mixed" | "unknown"; rel?: string };
export type UndoCheck = { allowed: string[]; skipped: UndoSkip[] };

// FIX5-0: 체크포인트 복원(과 Redo)이 파일마다 정한 처리. revert 는 체크포인트 내용으로, remove 는 에이전트가 그 뒤에 처음 만든 파일이라 휴지통으로, skip 은 에이전트의 마지막 쓰기 뒤 바뀌어 건드리지 않는다. rel 은 세션 폴더 기준 이름.
export type RestoreFile = { path: string; rel: string };
export type RestoreSkip = UndoSkip & { rel: string };
export type RestorePlan = { revert: RestoreFile[]; remove: RestoreFile[]; skip: RestoreSkip[] };
// FIX5-0: 동시에 돌던 다른 세션 때문에 Bash 귀속을 건너뛴 턴(at 은 턴이 끝난 시각 ISO, title 은 그 턴의 사용자 메시지 첫 줄)
export type ShellNote = { turns: { at: string; title: string }[] };

// 덩어리를 "유지"한 뒤의 기준. 없으면 git 기준(base 커밋의 내용)을 쓴다.
export type FileChange = { path: string; original: string | null; updatedAt: string };

export type QuickContext = { path: string; startLine: number; endLine: number; text: string };

export type QuickRun = {
  id: string;
  workspaceId: string;
  model: string;
  question: string;
  context: QuickContext;
  answer: string;
  status: "running" | "done" | "error";
  sessionId: string | null;
};

// TERMASK: 터미널에서 ⌘I 로 여는 명령 질문. 세션 목록에 남지 않고 도구 없이 텍스트로만 답한다(server/termask.ts).
export type TermAskRun = { id: string; model: string; question: string; answer: string; status: "running" | "done" | "error" };

// /btw 사이드 챗. 메인 세션을 forkSession 으로 갈라 이어 가므로 메인 기록은 바뀌지 않는다.
export type SideMessage = { role: "user" | "assistant"; text: string };
export type SideRun = {
  id: string;
  agentId: string;
  model: string;
  sessionId: string | null;
  messages: SideMessage[];
  status: "running" | "idle" | "error";
};

// 에디터 current line blame(git blame --porcelain 을 줄로 푼 것). lines[i] 는 파일 i+1 번째 줄을 쓴 커밋의 commits 인덱스다.
// 커밋 안 된 줄(저장 안 한 편집 포함)은 uncommitted 커밋 하나로 모은다. time 은 작성 시각(초). you 는 작성자 이메일이 이 저장소의 git config user.email 과 같은 경우.
export type BlameCommit = { hash: string; author: string; email: string; time: number; summary: string; message: string; you: boolean; uncommitted: boolean };
export type FileBlame = { commits: BlameCommit[]; lines: number[] };

export type ChangedFile = {
  path: string;
  rel: string;
  status: "A" | "M" | "D" | "R";
  additions: number;
  deletions: number;
  // R 이면 이름이 바뀌기 전 절대 경로 (기준 내용은 옛 이름으로 읽는다)
  from?: string;
  // 세션의 작업 폴더 밖(같은 git 저장소의 다른 폴더)에 있는 파일. 내용은 읽을 수 있지만 쓰기(Undo, Keep)는 작업 폴더 안만 된다.
  outside?: true;
  // FIX4A: Session 범위 파일이 에이전트의 마지막 쓰기 뒤에 바뀌었다(바깥 수정, 다른 세션 수정). Undo 는 이 파일을 건너뛴다.
  modifiedSince?: true;
};

export type GitInfo = {
  repoRoot: string | null;
  hasHead: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  // 변경 패널의 기준: worktree 면 기준 브랜치와의 merge-base, 아니면 세션 시작 커밋
  base: string | null;
  baseLabel: string | null;
  // B4: Branch Changes 메뉴 항목의 설명에 보이는 기준 브랜치(worktree 면 worktree 의 base, 아니면 원격 기본 브랜치나 지금 브랜치)
  baseBranch?: string | null;
  // TB: HEAD 커밋의 앞 7자리. 제목줄 브랜치 칩이 detached HEAD(branch 가 "HEAD") 일 때 이름 대신 보인다.
  headShort?: string | null;
  hasRemote?: boolean;
};

// B4: 변경 패널이 비교하는 범위. branch=기준 브랜치와의 merge-base 대비, uncommitted=HEAD 대비,
// session=세션 시작 커밋 대비(worktree 는 branch 와 같다. 갈래 세션은 갈래를 만든 시점의 작업 폴더 대비), lastTurn=마지막 턴이 시작될 때 내용 대비.
export const CHANGE_SCOPES = ["branch", "uncommitted", "session", "lastTurn"] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];
export const defaultChangeScope = (agent: { worktree: unknown; forkBased?: boolean }): ChangeScope => (agent.forkBased ? "session" : "branch");

// FIX4A: 워크트리 세션의 마무리. mergeInfo 의 blocker 는 지금 합칠 수 없는 이유(합칠 수 있으면 null).
export type WorktreeMergeInfo = { branch: string; target: string; unmerged: number; blocker: string | null };
export type WorktreePrResult = { kind: "created" | "existing" | "pushed"; url: string | null; message: string };

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  checks: { passing: number; failing: number; pending: number };
};

// 화면에서 집은 요소의 정보. 페이지가 모아 데몬에 보내고, 데몬은 ~/.agent-nav/feedback/<id>/element.json 에만 저장한다.
export type ElementInfo = {
  component: string | null;
  // data-source 속성 ("web/AgentView.tsx:142"). 가장 가까운 것부터 최대 3개
  sources: string[];
  tag: string;
  domPath: string;
  width: number;
  height: number;
  text: string;
  styles: Record<string, string>;
};

// FBNOEL: 피드백을 보낸 순간의 화면 상태. 요소를 고르지 않은 피드백에서 모델이 어느 화면 이야기인지 알아보는 근거다.
export type ScreenContext = {
  // 가운데 영역(Sessions, Board, Inbox, Pull requests)과 그 위에 열린 화면(Settings, Command palette 등, 없으면 null)
  view: string;
  overlay: string | null;
  // 활성 칸 이름(세션 제목이나 New session)과 열린 칸 수
  activePane: string;
  paneCount: number;
  layout: string;
  sidebar: boolean;
  rightPanel: string | null;
  bottomPanel: string | null;
  theme: string;
  // 창 안쪽 크기(CSS px)
  width: number;
  height: number;
};

// needsInput: 개선 세션이 파일을 바꾸지 않고 사용자에게 물으며 턴을 끝냈다. 답하면 후속 턴이 돌며 running 이 된다.
// fixing: 검사가 이 피드백 변경 탓의 새 실패로 떨어져 개선 세션에 고치라고 되돌려 보낸 중. 턴이 끝나면 검사를 다시 돈다.
// resolved, dismissed: 반영 안 됨(failed)으로 남은 항목을 사람이 정리한 것. resolved 는 이미 다른 길로 해결됐다고 표시(Resolved manually), dismissed 는 목록에서 숨김(필터로 다시 봄). 서버 상태에 저장된다.
// FBBLOCK: blocked 는 코드 탓이 아니라 환경(npm 을 못 찾음, 네트워크)이나 인증(Claude 로그인 만료) 탓에 멈춰 스스로 다시 시도하는 중이다. 실패가 아니라서 Not applied 개수에 들어가지 않는다.
export type FeedbackStatus = "running" | "checking" | "fixing" | "awaitingRestart" | "applied" | "failed" | "reverted" | "noChanges" | "needsInput" | "resolved" | "dismissed" | "blocked";

// FBBLOCK: reason 이 environment 면 nextRetryAt 에 다음 자동 재시도 시각이 있고, auth 면 인증이 돌아온 것이 확인될 때 다시 시작한다(nextRetryAt 은 null).
// stage 는 어디서 멈췄는가: checks 면 검사부터(Retry Checks), session 이면 개선 세션부터(Run Again) 다시 한다.
export type FeedbackBlock = { reason: "environment" | "auth"; stage: "checks" | "session"; nextRetryAt: string | null };

// CHKBASE: ignored 는 피드백 변경 없이도 이미 실패하던 항목 수, baseline 은 그 기준선 결과 요약(접어서 보인다).
export type FeedbackCheck = { name: string; ok: boolean; output: string; ignored?: number; baseline?: string };

export type Feedback = {
  id: string;
  agentId: string;
  text: string;
  // FBNOEL: 요소를 고르지 않고 보낸 피드백은 null. screen 은 그때 화면 상태, windowScreenshot 은 창 스크린샷(window.png)을 저장했는가.
  element: ElementInfo | null;
  screen?: ScreenContext | null;
  windowScreenshot?: boolean;
  screenshot: boolean;
  screenshotNote: string | null;
  status: FeedbackStatus;
  summary: string | null;
  // needsInput 일 때 개선 세션이 던진 질문 전문(표지 없음). 다른 상태에서는 null 이거나 없다.
  question?: string | null;
  changedFiles: string[];
  // server/, shared/, electron/ 을 바꾸는 피드백은 화면 다시 그리기로 반영할 수 없다
  needsRestart: boolean;
  // 재시작을 눌렀는데 진행 중인 턴이 있어 기다리는 중
  restartRequested: boolean;
  // 되돌린 뒤에도 실행 중인 데몬은 옛 코드를 쥐고 있어 한 번 더 재시작해야 하는 경우
  restartPending: boolean;
  checks: FeedbackCheck[];
  // FBRETRY: 실패한 검사를 다시 돌리는 중(status 는 checking). 끝나면 false
  retrying?: boolean;
  // 검사 실패를 개선 세션에 되돌려 보내 자동으로 고치게 한 횟수. 사용자가 직접 보낸 턴이나 Retry 로 다시 0부터 센다.
  fixAttempts?: number;
  // FBREDO: 데몬 재시작에 끊긴 적이 있다(이어 가지 못해 실패했다면 Run Again 이 보인다). 반영, 되돌림, 변경 없음, 질문 대기가 되면 지운다.
  interrupted?: boolean;
  // FBREDO: 본 작업 폴더와 합쳐지지 않아 실패했다(같은 줄 충돌, 또는 반영 직전 본 작업 폴더가 계속 바뀜). 재시도 단추가 Merge Again 이 된다.
  conflict?: boolean;
  // FBREDO: 재시작 뒤 이어 간 횟수. 턴이 정상으로 끝나면 0 으로 돌아간다.
  resumeCount?: number;
  // FBREBASE: 본 작업 폴더가 바뀌어 개선 세션의 변경이 같은 줄에서 충돌했을 때, 본 폴더 위에 다시 적용하라고 후속 턴을 자동으로 보낸 횟수. 사용자가 보낸 턴이 끝나면 0 으로 돌아간다.
  reapplyTries?: number;
  // FBREBASE: status 가 fixing 이고 그 턴이 검사 실패 수정이 아니라 본 폴더 위 재적용이다(배지가 Re-applying 으로 읽힌다)
  reapplying?: boolean;
  // FBREBASE: 마지막으로 대화에 남긴 실패 알림의 첫 줄과 타임라인 항목 id. 같은 사유로 연속 실패하면 새 알림 대신 이 항목을 갱신한다. 실패에서 벗어나면 지운다.
  failureNotice?: { head: string; itemId: string | null } | null;
  // FBBLOCK: status 가 blocked 인 동안의 이유. 다른 상태로 바뀌면 null.
  blocked?: FeedbackBlock | null;
  // FBBLOCK: 환경이나 인증 때문에 자동으로 다시 시도한 횟수. 반영 등 끝이 나거나 사람이 직접 다시 돌리면 0 으로 돌아간다.
  blockTries?: number;
  // FBBLOCK: 개선 세션이 오류로 끝나 아무것도 시작하지 못했다(Run Again 이 보인다)
  sessionFailed?: boolean;
  failure: string | null;
  worktree: string;
  seen: boolean;
  createdAt: string;
  updatedAt: string;
};

// G7: 에이전트에게 공유한 Browser 탭. pageId 는 탭 key 이고, 에이전트는 이 값으로만 페이지를 가리킨다(webContents id 는 알리지 않는다).
// visible 은 그 탭이 지금 보이는가(active 는 오른쪽 패널의 앞 탭, visible 은 같은 패널에서 보이지만 앞은 아님. 이 앱은 앞 탭만 보이므로 active 와 hidden 둘이다).
export type BrowserSharedPage = { pageId: string; agentId: string; url: string; title: string; visible?: "active" | "hidden" };

// G7: 페이지 도구 한 번의 결과. text 는 믿을 수 없는 페이지 내용을 포함할 수 있어 데몬이 경고문으로 감싼다. image 는 PNG base64.
export type BrowserToolOutput = { text?: string; image?: string };

export type BrowserToolName = "read_page" | "screenshot_page" | "click_element" | "drag_element" | "handle_dialog" | "hover_element" | "type_in_page" | "navigate_page" | "run_playwright_code" | "read_console_logs";

export type FormatterId = "eslint" | "prettier" | "oxc" | "tsserver";

export type FormatProblem =
  // 설정한 확장이 이 언어를 포맷하지 못한다(도구를 못 찾았거나 꺼져 있음). detail 은 이유 한 줄.
  | { kind: "cannotFormat"; extension: string; detail: string | null }
  // 설정한 포맷터가 문서 전체만 포맷할 수 있어 선택 영역은 못 한다
  | { kind: "selectionUnsupported"; extension: string }
  // 설정한 확장이 깔려 있지 않다
  | { kind: "unavailable"; extensionId: string }
  // 설정한 확장은 있지만 agent-nav 가 돌릴 수 없는 종류(Biome 등)
  | { kind: "unsupported"; extension: string }
  // 기본 포맷터를 안 골랐는데 후보가 둘 이상
  | { kind: "ambiguous" }
  // 이 언어를 포맷할 것이 하나도 없다
  | { kind: "none" };
export type FormatChoice = { formatter: FormatterId; label: string };
export type FormatResult = {
  // null 이고 formatter 가 tsserver 면 화면이 LSP 로 포맷한다. null 이고 problem 이 있으면 아무것도 바꾸지 않는다.
  text: string | null;
  formatter: FormatterId | null;
  language: string;
  problem?: FormatProblem;
  // problem 이 있을 때 대신 쓸 수 있는 포맷터. 저장소에 설정 파일이 있는 것이 앞선다.
  alternatives?: FormatChoice[];
};
// FMT: Settings 의 언어별 포맷터 선택에 쓰는 한 줄
export type FormatLanguage = {
  id: string;
  name: string;
  // agent-nav 에서 고른 값
  chosen: FormatterId | null;
  vscode: { raw: string | null; formatter: FormatterId | null; scope: "workspace" | "user" | null; label: string | null; supported: boolean };
  options: FormatChoice[];
};

export type ImportedFrom = {
  source: "vscode";
  vsSessionId: string;
  chatId: string;
  origin: "user" | "sideChat" | null;
  importedAt: string;
  syncedMtimeMs: number;
  syncedUntil: string | null;
  // 가져올 때 작업 폴더가 없었다
  cwdMissing?: boolean;
  vsRunning?: boolean;
};

export type VscodeCandidate = {
  key: string;
  claudeSessionId: string | null;
  vsSessionId: string;
  chatId: string;
  kind: "main" | "peer";
  parentKey: string | null;
  origin: "user" | "sideChat" | null;
  title: string;
  cwd: string | null;
  cwdExists: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  chats: number;
  // 서브에이전트 채팅은 따로 이어 갈 Claude 세션이 아니라서 가져오지 않는다. 기본 채팅 행에 수만 알린다.
  subagentChats: number;
  hasJsonl: boolean;
  archived: boolean;
  unread: boolean;
  running: boolean;
  from: "cache" | "session" | "both";
  importedAgentId: string | null;
  // 가져올 수 없는 사유. 목록에서 체크박스가 꺼진다.
  problem: "noSessionId" | "noTranscript" | null;
};

export type VscodeImportList = {
  available: boolean;
  // 상태 파일을 못 읽었을 때의 사유
  reason: string | null;
  stateFile: string;
  candidates: VscodeCandidate[];
  stats: { cached: number; cachedExternal: number; sessionDb: number; importable: number; alreadyImported: number };
};

export type VscodeImportResult = {
  key: string;
  agentId: string | null;
  outcome: "created" | "updated" | "unchanged" | "skipped" | "failed";
  // 타임라인 항목 수, 이번에 더한 항목 수
  items: number;
  added: number;
  note: string | null;
};

// PR: pr.* 메서드는 shared/prTypes.ts 에 있다.
export type BranchesResult = { repoRoot: string | null; current: string | null; defaultBase: string | null; branches: string[]; locals: string[]; remotes: string[]; uncommitted: number };

export type RpcMethods = PrRpcMethods & LinearRpcMethods & SimulatorRpcMethods & SkillsRpcMethods & {
  "workspaces.list": { params: Record<string, never>; result: Workspace[] };
  // SESSIONORDER: 사이드바에서 손으로 정한 세션 순서(shared/sessionOrder.ts). scope 마다 id 목록이고, 바뀔 때마다 sessionOrders 이벤트로 모든 화면에 보낸다. 모바일 허용 목록에는 없다.
  "sessionOrder.list": { params: Record<string, never>; result: SessionOrders };
  "sessionOrder.set": { params: { scope: string; ids: string[] }; result: SessionOrders };
  "sessionOrder.reset": { params: { scopes: string[] }; result: SessionOrders };
  "workspaces.add": { params: { dir: string }; result: Workspace };
  // OPENFOLDER: 바깥에서 넘겨받은 폴더(open -a, Dock 에 끌어 놓기)를 연다. add 와 같지만 git worktree 폴더면 원 레포 워크스페이스를 부모로 먼저 등록하고 그 아래에 붙인다. 이미 있는 폴더는 그대로 돌려준다.
  "workspaces.open": { params: { dir: string }; result: Workspace };
  // WSMENU: 목록에서 폴더를 뺀다. 세션이 있으면 지우지 않고 숨겨 두었다가 같은 폴더를 다시 추가하면 돌려놓는다(hidden 은 숨긴 세션 수). 도는 세션이 있으면 거절한다.
  "workspaces.remove": { params: { id: string }; result: { hidden: number } };
  // fix5-3: 디스크에서 사라진 폴더를 새 경로로 다시 잇는다. 세션은 그대로이고 폴더 안 세션의 작업 폴더만 새 경로로 바뀐다(worktree 세션은 그대로).
  "workspaces.relocate": { params: { id: string; dir: string }; result: Workspace };
  "workspaces.reveal": { params: { workspaceId: string }; result: null };
  "files.list": { params: { workspaceId: string }; result: string[] };
  // QUICKOPEN: .gitignore 로 가려진 파일(Go to File 의 "Includes excluded folders" 가 켜졌을 때만 부른다). git 저장소가 아니면 빈 목록.
  "files.ignored": { params: { workspaceId: string }; result: string[] };
  // 웹 모드 Browser 탭: 이 주소를 iframe 으로 열 수 있는지(응답 머리의 프레임 제한)를 데몬이 받아 본다. http 와 https 만.
  "browser.probe": { params: { url: string }; result: { ok: boolean; status: number | null; reason: string | null } };
  // 본문 검색. 결과의 path 는 작업 폴더 기준 상대 경로이고, rows 는 일치한 줄과 앞뒤 줄이다.
  "files.search": {
    params: { workspaceId: string; query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; context: number; include?: string; exclude?: string; ignore?: boolean; ranges?: boolean };
    // ranges 는 text 안의 구간(UTF-16 오프셋). 줄이 길어 앞을 잘랐으면 offset 은 text 가 줄의 몇 번째 글자에서 시작하는지다.
    result: { files: { path: string; rows: { line: number; text: string; match: boolean; ranges?: { start: number; end: number }[]; offset?: number }[] }[]; matches: number; truncated: boolean; engine: "rg" | "git" };
  };
  "search.settings": { params: Record<string, never>; result: SearchSettings };
  // 요소 선택과 공유에 쓰는 스크린샷(PNG base64)을 데몬 폴더에 저장하고 파일 경로를 돌려준다. 에이전트가 이 경로를 Read 로 본다.
  "browser.saveShot": { params: { png: string }; result: { path: string } };
  // G7: 이 화면(연결)에서 에이전트에게 공유한 Browser 탭 목록을 통째로 바꾼다. 연결이 끊기면 그 연결이 올린 공유는 사라진다.
  // open 은 공유되지 않은 채 열려 있는 Browser 탭 수(list_browser_pages 안내문이 쓴다).
  "browser.setShares": { params: { pages: BrowserSharedPage[]; open?: number }; result: null };
  // G8: 에이전트 도구가 남긴 스크린샷(타임라인 썸네일)을 읽는다. 데몬이 저장한 폴더 안의 파일만 읽는다.
  "browser.readShot": { params: { path: string }; result: { png: string | null } };
  // ASIDEVIEW: Aside 호출 행의 이미지. 후보 경로(결과 글에 남은 파일 경로) 중 처음 읽히는 이미지를 돌려준다. 정해진 폴더의 이미지 파일만 읽는다.
  "aside.readImage": { params: { paths: string[] }; result: { mime: string; data: string } | null };
  // INLINEMEDIA: 대화 속 이미지와 영상 경로가 미리보기를 붙여도 되는 파일인지 확인하고, 읽을 수 있는 것에는 GET /media 주소를 준다. 입력과 같은 순서이고 읽을 수 없는 경로(없음, 허용 범위 밖, 크기 초과)는 null 이다.
  "media.resolve": { params: { agentId: string; paths: string[] }; result: (MediaInfo | null)[] };
  // G7: browserTool 이벤트에 대한 응답. 화면이 메인 프로세스에서 실행한 결과(또는 오류)를 데몬에 돌려준다.
  "browser.toolResult": { params: { id: string; result?: BrowserToolOutput; error?: string }; result: null };
  // mtimeMs 는 읽은 시점의 수정 시각(없는 파일이면 null). 에디터가 저장할 때 baseMtimeMs 로 돌려줘 그 사이 디스크가 바뀌었는지 가린다.
  // binary 이면 text 는 빈 문자열이고 size 만 알린다(앞 8000바이트에 NUL). readOnly 는 데몬이 쓸 수 없는 파일.
  "files.read": { params: { workspaceId: string; path: string }; result: { text: string | null; mtimeMs?: number | null; binary?: boolean; size?: number; readOnly?: boolean } };
  // 이미지 미리보기용 원본 바이트. 16MB 를 넘으면 base64 가 null 이다. mime 은 이미지 확장자일 때만.
  "files.readBinary": { params: { workspaceId: string; path: string }; result: { base64: string | null; mime: string | null; size: number } };
  // 수정 시각만 본다(없는 파일이면 null). 에이전트가 연 파일을 고쳤는지 확인하는 데 쓴다.
  // APPROVE: 편집 승인 카드가 수정 전 내용을 보려고 세션의 작업 폴더(워크트리 포함) 기준으로 읽는다. 없는 파일은 text 가 null.
  "files.readOfAgent": { params: { agentId: string; path: string }; result: { text: string | null } };
  "files.stat": { params: { workspaceId: string; path: string }; result: { mtimeMs: number | null } };
  // 자주 읽는 GitHub 저장소(owner/name)의 로컬 클론 폴더(server/repoMirror.ts). 아직 클론하지 않았으면 null. request 면 아직 없을 때 클론을 시작한다(링크를 눌렀을 때).
  "repos.mirrorDir": { params: { repo: string; request?: boolean }; result: { dir: string | null } };
  // FIX6C: 에디터 변경 거터의 기준. HEAD 에 있는 그 파일의 내용. repo 가 false 면 git 저장소가 아니고, text 가 null 이면 HEAD 에 없는 파일(추적 안 한 새 파일)이거나 너무 큰 파일이다.
  "files.headText": { params: { workspaceId: string; path: string }; result: { repo: boolean; text: string | null } };
  // 에디터 저장. baseMtimeMs 는 마지막으로 읽거나 저장한 때의 수정 시각이고 null 이면 새 파일(이미 있으면 충돌). 디스크가 그 사이 바뀌었고 내용도 다르면 쓰지 않고 conflict 로 답한다. force 면 덮어쓴다.
  // 경로는 작업 폴더 안(심볼릭 링크를 푼 뒤에도)만 받는다.
  "files.save": {
    params: { workspaceId: string; path: string; text: string; baseMtimeMs: number | null; force?: boolean };
    result: { saved: true; mtimeMs: number } | { saved: false; conflict: "changed" | "exists" | "readonly"; mtimeMs: number | null };
  };
  // 새 파일이나 폴더. 이미 있으면 덮어쓰지 않고 오류. 작업 폴더 밖 경로는 거절한다. 위 폴더가 없으면 함께 만든다.
  "files.create": { params: { workspaceId: string; path: string; kind: "file" | "folder"; text?: string }; result: { mtimeMs: number } };
  // R4FIX: Files 트리 우클릭 메뉴. rename 은 이미 있는 이름이면 오류, trash 는 휴지통으로 옮기고(영구 삭제 없음) 옮겨 간 경로를 돌려준다, reveal 은 Finder 에서 그 항목을 고른다.
  "files.rename": { params: { workspaceId: string; from: string; to: string }; result: null };
  "files.trash": { params: { workspaceId: string; path: string }; result: { trashed: string } };
  "files.reveal": { params: { workspaceId: string; path: string }; result: null };
  // 파일이 하나도 없는 폴더(git ls-files 에 안 보이는 폴더)의 작업 폴더 기준 경로. Files 트리가 빈 폴더를 그리는 데 쓴다.
  "files.dirs": { params: { workspaceId: string }; result: string[] };
  "format.run": {
    // formatter 를 주면 설정과 상관없이 이번 한 번만 그 포맷터로 한다(알림의 "Format with ...")
    params: { workspaceId: string; path: string; text: string; range?: { from: number; to: number }; formatter?: FormatterId };
    result: FormatResult;
  };
  "format.config": { params: { workspaceId?: string }; result: { formatOnSave: boolean; source: DefaultSource; languages: FormatLanguage[] } };
  // 그 세션의 변경 집합(git 기준)에 있는 파일만 되돌릴 수 있다. text 가 null 이면 파일을 지운다.
  "files.write": { params: { agentId: string; path: string; text: string | null }; result: null };
  "files.openInVSCode": {
    params: { workspaceId: string; path: string; line: number; column: number };
    result: null;
  };
  "workspaces.openInVSCode": { params: { agentId?: string; workspaceId?: string }; result: null };
  // `/` 메뉴 보충: 데몬을 띄운 뒤에 만든 스킬과 워크스페이스 폴더의 스킬을 디스크에서 바로 읽는다.
  "commands.local": { params: { workspaceId: string }; result: CommandInfo[] };
  "meta.get": { params: Record<string, never>; result: Meta };
  // CODEX: Codex 앱 서버에서 모델 목록과 로그인 상태를 읽는다. refresh 가 아니면 몇 분 동안 캐시를 돌려준다.
  "codex.meta": { params: { refresh?: boolean }; result: CodexMeta };
  "meta.refresh": { params: Record<string, never>; result: Meta };
  "mcp.reconnect": { params: { name: string }; result: McpActionResult };
  "mcp.toggle": { params: { name: string; enabled: boolean }; result: McpActionResult };
  "runtime.info": { params: Record<string, never>; result: RuntimeInfo };
  "settings.get": { params: Record<string, never>; result: Settings };
  "defaults.get": { params: Record<string, never>; result: ResolvedDefaults };
  "settings.set": { params: Partial<Settings>; result: Settings };
  "logs.tail": { params: { lines: number }; result: string[] };
  "agents.list": { params: Record<string, never>; result: Agent[] };
  "agents.create": {
    params: {
      workspaceId: string | null;
      prompt: string;
      permissionMode: PermissionMode;
      model: string | null;
      effort: EffortLevel | null;
      worktree: { branch: string; base: string } | null;
      // 보드 카드에서 시작한 세션이면 그 카드. 첫 턴이 시작되기 전에 연결해서 자동 이동 규칙이 첫 실행을 본다.
      boardCardId?: string;
      // HANDOFF: 핸드오프로 시작하는 세션이면 원 세션 id 와 인계 문서 id. shown 은 첫 말풍선에 보일 사용자가 쓴 글(prompt 에는 인계 문서가 함께 들어 있다).
      handoffFrom?: string;
      handoffId?: string;
      shown?: string;
      // fixB: 첫 메시지에 붙은 이미지(images.upload 로 올린 것)
      images?: ImageRef[];
      // FILEATTACH: 첫 메시지에 붙은 파일(경로만 모델에 간다)
      files?: FileRef[];
      // CODEX: 세션을 돌릴 도구. 없으면 claude.
      harness?: Harness;
    };
    result: Agent;
  };
  // NOTION2: Notion 쓰기 제안 카드의 결정. apply 면 승인한 그 내용 그대로 Notion 에 쓰고, 아니면 아무것도 보내지 않는다. feedback 은 거절 이유로 모델에 간다.
  "agents.respondNotionWrite": { params: { agentId: string; itemId: string; apply: boolean; feedback?: string }; result: null };
  // HANDOFF: 세션 기록에서 인계 문서를 만든다(읽기 전용 쿼리, 원 세션 기록은 그대로). 문서는 ~/.agent-nav/handoffs/<id>.md 에도 남는다.
  "handoff.create": { params: { agentId: string }; result: { id: string; title: string; text: string; path: string } };
  "handoff.read": { params: { id: string }; result: { id: string; text: string; path: string } };
  // 칩에서 고친 문서를 파일에도 반영한다.
  "handoff.save": { params: { id: string; text: string }; result: null };
  // B3: 응답 중이면 steer 가 아닌 한 큐에 들어가고 queued 가 true 로 온다. steer 는 진행 중인 턴에 바로 끼어든다(응답 중이 아니면 그냥 보낸다).
  "agents.send": { params: { agentId: string; prompt: string; steer?: boolean; images?: ImageRef[]; files?: FileRef[] }; result: { queued: boolean } };
  // fixB: 입력창 이미지를 ~/.agent-nav/images 에 저장한다(보낼 때 한 번). data 는 base64. 형식과 크기가 안 맞으면 이유를 담아 거절한다.
  "images.upload": { params: { mediaType: string; data: string; name: string }; result: { id: string } };
  // FILEATTACH: 업로드 폴백(POST /attachments)으로 ~/.agent-nav/attachments/<id> 에 저장한 파일을 지운다. 칩을 보내기 전에 지웠을 때 고아 파일을 남기지 않으려고 부른다.
  "attachments.discard": { params: { id: string }; result: null };
  // B3: 큐에서 뺀다. 빼낸 글을 돌려준다(Edit 이 입력창으로 되돌림). 이미 나간 항목이면 null.
  "agents.dequeue": { params: { agentId: string; queueId: string }; result: { text: string } | null };
  // DIFFFB: 쌓인 diff 피드백. add 는 만든 피드백을, send 는 응답 중이면 queued 를 돌려준다. ids 가 없으면 쌓인 것 전부를 보낸다. text 는 입력창 글(말풍선에 보이는 글)이다.
  "diffFeedback.list": { params: { agentId: string }; result: DiffFeedback[] };
  "diffFeedback.add": { params: { agentId: string; item: Omit<DiffFeedback, "id" | "state" | "createdAt"> }; result: DiffFeedback };
  "diffFeedback.update": { params: { agentId: string; id: string; text: string }; result: null };
  "diffFeedback.remove": { params: { agentId: string; id: string }; result: null };
  "diffFeedback.clear": { params: { agentId: string }; result: null };
  "diffFeedback.send": { params: { agentId: string; text?: string; steer?: boolean; ids?: string[] }; result: { queued: boolean } };
  // QUEUECANCEL: 끼어들기 대기(Steering) 메시지를 거둔다. cancelled 면 text 를 돌려주고(Edit 이 입력창으로 되돌림), CLI 가 이미 넘겨받았으면 cancelled false 로 그 항목에 sent 표지를 단다. 이미 대화로 옮겨졌으면 null.
  "agents.cancelSteering": { params: { agentId: string; steeringId: string }; result: { cancelled: true; text: string } | { cancelled: false } | null };
  // B3: 큐의 한 항목을 지금 보낸다(응답 중이면 끼어들기).
  "agents.sendQueuedNow": { params: { agentId: string; queueId: string }; result: null };
  "agents.interrupt": { params: { agentId: string }; result: null };
  "agents.timeline": { params: { agentId: string }; result: TimelineItem[] };
  "agents.setPermissionMode": { params: { agentId: string; mode: PermissionMode }; result: null };
  "agents.setModel": { params: { agentId: string; model: string | null }; result: null };
  "agents.setEffort": { params: { agentId: string; effort: EffortLevel | null }; result: null };
  "agents.respondPermission": {
    params: { agentId: string; itemId: string; decision: PermissionDecision };
    result: null;
  };
  // fixB: AskUserQuestion 카드의 답. answers 는 질문 글 -> 고른 label(여러 개는 ", ", 기타는 사용자가 쓴 글). skip 이면 질문에 답하지 않고 넘긴다.
  "agents.answerQuestion": {
    params: { agentId: string; itemId: string; answers: Record<string, string> | null };
    result: null;
  };
  // fixB: ExitPlanMode 카드의 결정. approve 는 mode 로 권한 모드를 바꾸고 진행, 아니면 feedback 글과 함께 계속 계획.
  "agents.respondPlan": {
    params: { agentId: string; itemId: string; approve: true; mode: "acceptEdits" | "default" } | { agentId: string; itemId: string; approve: false; feedback?: string };
    result: null;
  };
  // worktree 가 있으면 removeWorktree 로 같이 지울지 정한다. 변경이 남아 있으면 거절한다(강제 삭제 없음).
  "agents.remove": { params: { agentId: string; removeWorktree: boolean }; result: null };
  // unmerged: 기준 브랜치에 아직 없는 브랜치 커밋 수(기준 브랜치를 못 찾으면 null). 삭제 확인 창이 "브랜치는 남는다" 와 함께 알린다.
  "agents.worktreeStatus": { params: { agentId: string }; result: { dirty: boolean; summary: string; unmerged: number | null; branch: string; base: string } | null };
  // FIX4A: 워크트리 세션의 합치기와 PR. merge 와 createPr 은 confirmed 가 없으면 거절한다.
  "worktree.mergeInfo": { params: { agentId: string }; result: WorktreeMergeInfo | null };
  "worktree.merge": { params: { agentId: string; confirmed: true }; result: { target: string; fastForward: boolean; commits: number; affectedAgentIds: string[] } };
  "worktree.createPr": { params: { agentId: string; confirmed: true }; result: WorktreePrResult };
  // B2: beforeItemId(사용자 메시지 항목 id)가 있으면 그 메시지 바로 앞까지의 대화로 시작하는 새 세션(메시지 단위 Fork). 없으면 세션 전체 갈래.
  "agents.fork": { params: { agentId: string; beforeItemId?: string }; result: Agent };
  // B2: 그 사용자 메시지 시점으로 파일과 대화를 되돌린다. text 는 입력창에 다시 채울 그 메시지 글, files 는 되돌린 파일 수. chatOnly 는 파일 스냅샷이 없어 대화만 되돌렸다는 뜻이다.
  // reverted 는 이전 내용으로 되돌린 파일 수(files 에서 휴지통으로 보낸 removed 를 뺀 값). 확인 창의 "되돌림" 수와 같은 계획 값이다.
  "agents.restoreCheckpoint": { params: { agentId: string; itemId: string }; result: { text: string; files: number; chatOnly: boolean; reverted?: number; removed?: number; skipped?: RestoreSkip[] } };
  // 되돌리지 않고 dryRun 으로 되돌아갈 파일 수만 센다. 화면이 파일 편집을 버리는 복원에서 한 번 더 확인할지 정하는 데 쓴다.
  "agents.previewCheckpoint": { params: { agentId: string; itemId: string }; result: { files: number; plan?: RestorePlan } };
  "agents.cancelRestore": { params: { agentId: string }; result: null };
  "agents.redoCheckpoint": { params: { agentId: string }; result: { files: number; chatOnly: boolean; skipped?: RestoreSkip[] } };
  // B2: messageId 가 없는 사용자 항목(체크포인트 이전에 보낸 메시지)별 복원 범위. messageId 가 있는 항목은 항상 files 라 담지 않는다. 응답 중이면 거절한다.
  "agents.checkpointModes": { params: { agentId: string }; result: Record<string, CheckpointMode> };
  // B1: 사이드바 행 동작. 읽음, 고정, 완료, 이름은 updatedAt(정렬과 상대 시간 기준)을 올리지 않는다.
  "agents.markRead": { params: { agentId: string; read: boolean }; result: null };
  // FIX3-7: 이 창의 칸에 열려 있는 세션들. 데몬은 열린 세션의 프로세스를 유휴로 닫지 않는다. 열린 칸이 바뀔 때마다 통째로 보낸다(연결이 끊겼다 이어지면 다시 보낸다).
  "agents.setOpen": { params: { agentIds: string[] }; result: null };
  // FIX4A: 이 연결이 보고 있는 폴더 목록으로 바꾼다. 데몬이 그 저장소의 파일 변화를 감시해 workspaceChanged 로 알린다.
  "workspaces.watch": { params: { workspaceIds: string[] }; result: null };
  // PERFDAEMON: 끝난 피드백의 worktree 와 되돌리기 백업 정리(shared/feedbackRetention.ts). tidyPlan 은 아무것도 지우지 않고 무엇이 정리될지만 계산한다. tidyRun 만 지운다(진행 중이거나 다시 돌릴 수 있는 피드백은 건드리지 않는다).
  "feedback.tidyPlan": { params: { policy?: Partial<RetentionPolicy> }; result: TidyPlan };
  "feedback.tidyRun": { params: { policy?: Partial<RetentionPolicy> }; result: TidyResult };
  // PERFDAEMON: 데몬이 한 일의 개수와 바이트(server/perfStats.ts). reset 이면 읽은 뒤 0부터 다시 센다.
  "perf.stats": { params: { reset?: boolean }; result: { since: number; now: number; buckets: Record<string, { count: number; bytes: number; ms: number }>; process: { rssMb: number; heapMb: number; cpuUserMs: number; cpuSystemMs: number }; watch: { events: number; ignored: number; emits: number; watched: number } } };
  "app.showAgent": { params: { agentId: string }; result: null };
  "agents.setPinned": { params: { agentId: string; pinned: boolean }; result: null };
  "agents.setDone": { params: { agentId: string; done: boolean }; result: null };
  "agents.rename": { params: { agentId: string; title: string }; result: null };
  "changes.list": { params: { agentId: string }; result: FileChange[] };
  "changes.setOriginal": { params: { agentId: string; path: string; original: string | null }; result: null };
  "changes.clear": { params: { agentId: string; path: string | null }; result: null };
  // FIX4A: Undo 전에 어느 파일이 되돌려지는지 가른다(장부의 에이전트 마지막 쓰기와 디스크가 같은 파일만 허용). 확인 창이 이 결과로 파일 이름을 보인다.
  "changes.checkUndo": { params: { agentId: string; paths: string[] }; result: UndoCheck };
  // FIX4A: 파일을 기준 내용으로 되돌린다. 서버가 checkUndo 와 같은 검사를 다시 하고 허용된 파일만 쓴다(text null 은 파일을 휴지통으로).
  "changes.undo": { params: { agentId: string; items: { path: string; text: string | null }[] }; result: UndoCheck & { reverted: string[] } };
  "git.info": { params: { agentId: string }; result: GitInfo };
  "git.fetch": { params: { agentId: string }; result: GitInfo };
  "git.push": { params: { agentId: string }; result: { output: string } };
  "git.pull": { params: { agentId: string }; result: { output: string } };
  // includeOutside: 세션의 작업 폴더 밖 파일(같은 저장소의 다른 폴더)도 넣는다(기본은 뺀다). outsideCount 는 뺀 파일 수(includeOutside 이면 넣은 파일 중 밖에 있는 수)
  "git.changes": { params: { agentId: string; scope?: ChangeScope; includeOutside?: boolean }; result: { base: string | null; files: ChangedFile[]; outsideCount: number; shellNote?: ShellNote } };
  // R4FIX: 새 세션 화면의 Changes 탭. 세션 없이 폴더만으로 커밋 안 된 변경(HEAD 기준, 폴더 밖 파일 제외)을 +N -N 과 함께 읽는다. 첫 커밋 전 저장소는 비어 있다.
  "git.workspaceChanges": { params: { workspaceId: string }; result: { files: ChangedFile[] } };
  "git.original": { params: { agentId: string; path: string; scope?: ChangeScope; from?: string }; result: { text: string | null } };
  // 에디터 current line blame. text 는 저장 안 한 버퍼(있으면 git blame --contents - 로 줄 번호를 맞춘다). blame 이 null 이면 저장소가 아니거나 HEAD 에 없는 파일이라 표시하지 않는다.
  "git.blame": { params: { workspaceId: string; path: string; text?: string }; result: { blame: FileBlame | null } };
  "git.branches": {
    params: { workspaceId: string };
    // uncommitted: 커밋하지 않은 변경 파일 수(새 세션 화면의 브랜치 메뉴가 보인다)
    // locals, remotes: 브랜치 선택기용. remotes 는 origin/name 꼴이고 origin/HEAD 는 없다. branches 는 둘을 섞은 옛 목록이다.
    result: BranchesResult;
  };
  // BRANCH-SWITCH: git switch. 같은 저장소에서 응답 중인 세션이 있으면 allowBusy 가 true 일 때만 바꾸고, 아니면 switched:false 와 그 세션 제목들(busy)만 돌려준다.
  // git 이 거절하면(커밋 안 된 변경이 겹침, 다른 worktree 가 쓰는 브랜치) 오류로 올라가고 아무것도 바뀌지 않는다. affectedAgentIds: 같은 저장소를 쓰는 세션(git 정보를 다시 읽어야 한다)
  // FIX4A: 새 워크트리 브랜치 이름의 문제(git check-ref-format 기준, 이미 있는 이름). 문제가 없으면 problem 이 null.
  "git.checkBranchName": { params: { workspaceId: string; branch: string }; result: { problem: string | null } };
  "git.switchBranch": { params: { workspaceId: string; branch: string; allowBusy?: boolean }; result: { switched: boolean; busy: string[]; affectedAgentIds: string[]; info: BranchesResult } };
  "git.prs": { params: { agentId: string }; result: { available: boolean; reason: string | null; prs: PullRequest[] } };
  // SCM: Source Control 보기 (server/scm.ts). 경로는 저장소 루트 기준이고 저장소 밖이면 거절한다. discard 는 새 파일을 휴지통으로 옮긴다.
  "scm.status": { params: ScmTarget; result: ScmStatus };
  "scm.stage": { params: ScmTarget & { paths: string[] }; result: null };
  "scm.unstage": { params: ScmTarget & { paths: string[] }; result: null };
  "scm.discard": { params: ScmTarget & { paths: string[] }; result: ScmDiscardResult };
  "scm.commit": { params: ScmTarget & { options: ScmCommitOptions }; result: ScmCommitResult };
  "scm.undoCommit": { params: ScmTarget; result: { message: string } };
  "scm.generateMessage": { params: ScmTarget & { model: string }; result: { message: string } };
  "scm.graph": { params: ScmTarget & { limit?: number }; result: ScmCommit[] };
  "scm.commitFiles": { params: ScmTarget & { hash: string }; result: ScmCommitFile[] };
  "scm.commitDiff": { params: ScmTarget & { hash: string; rel: string; from?: string }; result: { text: string; truncated: boolean } };
  "scm.worktrees": { params: Record<string, never>; result: ScmRepoWorktrees[] };
  // 목록에 있는 worktree 폴더만 받는다. 작업 폴더로 등록해(이미 있으면 그대로) id 를 돌려준다.
  "scm.openWorktree": { params: { path: string }; result: { workspaceId: string } };
  // FIX6B: 세션 없이도 보이는 저장소에 pull, push, fetch. 실패는 오류가 아니라 분류된 문제(ok:false)로 돌려준다. pull 의 mode 기본값은 ff(빨리 감기만).
  "scm.pull": { params: ScmTarget & { mode?: ScmPullMode }; result: ScmSyncResult };
  "scm.push": { params: ScmTarget; result: ScmSyncResult };
  "scm.fetch": { params: ScmTarget; result: ScmSyncResult };
  // FIX6B: 병합이나 리베이스 이어가기(충돌이 남았으면 ok:false), 중단
  "scm.continue": { params: ScmTarget & { message?: string }; result: ScmOperationResult };
  "scm.abort": { params: ScmTarget; result: null };
  // FIX6B: 파일 diff 의 두 쪽 내용과 git hunk 목록, hunk 하나를 stage(changes)하거나 unstage(staged). hash 는 읽은 hunk 의 지문이고 달라졌으면 거절한다.
  "scm.fileDiff": { params: ScmTarget & { rel: string; section: ScmDiffSection }; result: ScmFileDiff };
  "scm.stageHunk": { params: ScmTarget & { rel: string; section: ScmDiffSection; index: number; hash: string }; result: null };
  "scm.discardHunk": { params: ScmTarget & { rel: string; index: number; hash: string }; result: null };
  "quick.ask": {
    params: { id: string; workspaceId: string; model: string; question: string; context: QuickContext };
    result: null;
  };
  "quick.cancel": { params: { id: string }; result: null };
  "quick.adopt": { params: { id: string }; result: Agent };
  // TERMASK: 명령 질문. context 는 화면이 모은 것(마지막 줄들과 선택은 이미 비밀값을 가렸다). pty.info 는 터미널 셸의 현재 작업 폴더(cd 한 뒤 값), 셸 이름, OS 를 읽는다.
  "termask.ask": { params: { id: string; model: string; question: string; context: TermAskContext }; result: null };
  "termask.cancel": { params: { id: string }; result: null };
  "pty.info": { params: { ptyId: string }; result: { cwd: string; shell: string; os: string } };
  "side.ask": { params: { id: string; agentId: string; model: string; question: string }; result: null };
  "side.cancel": { params: { id: string }; result: null };
  "side.adopt": { params: { id: string }; result: Agent };
  // screenshot 은 PNG base64. 브라우저 탭에서는 캡처 수단이 없어 null 과 이유를 보낸다.
  "feedback.create": {
    // FBNOEL: element 가 null 이면 요소 없는 피드백. windowScreenshot 은 창 전체 PNG base64(없으면 null), thumb 은 말풍선 칩용 작은 JPEG data URL.
    params: { text: string; element: ElementInfo | null; screenshot: string | null; screenshotNote: string | null; screen?: ScreenContext | null; windowScreenshot?: string | null; thumb?: string | null };
    result: Feedback;
  };
  "feedback.sourceReady": { params: Record<string, never>; result: { ready: boolean } };
  "feedback.list": { params: Record<string, never>; result: Feedback[] };
  "feedback.revert": { params: { id: string }; result: Feedback };
  "feedback.restart": { params: { id: string }; result: Feedback };
  // FBRETRY: 검사 단계에서 실패한 피드백의 검사만 다시 돌린다(개선 세션은 다시 돌리지 않는다). 검사가 끝나는 걸 기다리지 않고 checking 상태의 기록을 돌려준다.
  "feedback.retryChecks": { params: { id: string }; result: Feedback };
  // FBREDO: 재시작에 끊겨 이어 가지 못한 피드백을 같은 요청(글, 고른 요소, 스크린샷)으로 새 개선 세션에서 처음부터 다시 돌린다. 새 피드백을 돌려준다.
  "feedback.runAgain": { params: { id: string }; result: Feedback };
  "feedback.markSeen": { params: { id: string }; result: null };
  // deferred: 직전 재시작 뒤 쿨다운(shared/restartGate.ts)에 걸려 inMs 뒤에 데몬이 알아서 재시작한다. 그 사이 온 요청은 하나로 합쳐진다.
  "daemon.restartIfIdle": { params: Record<string, never>; result: { restarted: boolean; busy: number; deferred?: boolean; inMs?: number } };
  // FBREDO: 반영 안 됨(failed) 항목을 사람이 정리한다. resolve 는 해결됨으로 표시(Resolved manually), dismiss 는 목록에서 숨김.
  "feedback.resolve": { params: { id: string }; result: Feedback };
  "feedback.dismiss": { params: { id: string }; result: Feedback };
  "inbox.get": { params: Record<string, never>; result: InboxState };
  // Slack 에서 새 알림을 가져온다 (모델 한 번 호출). 이미 가져오는 중이면 그 결과를 기다린다.
  "inbox.refresh": { params: Record<string, never>; result: InboxState };
  "inbox.markRead": { params: { ids: string[]; read: boolean }; result: InboxState };
  "inbox.archive": { params: { ids: string[]; archived: boolean }; result: InboxState };
  // 항목의 스레드를 Slack 에서 읽어 와 항목에 저장한다.
  "inbox.thread": { params: { id: string }; result: InboxItem };
  // 멘션을 보드 카드로 만든다 (Todo 열, 라벨 slack). 이미 카드가 있으면 그 카드를 돌려준다.
  "inbox.addToBoard": { params: { id: string; workspaceId?: string | null }; result: { item: InboxItem; card: BoardCard } };
  // 멘션을 다시 분석해 연결된 카드를 새 결과로 고친다 (제목, 설명, 워크스페이스). 큐에 넣고 바로 돌려준다.
  "inbox.reanalyze": { params: { id: string }; result: InboxState };
  // 요청이 아니라고 정정한다. 이 멘션으로 만든 카드가 있으면 지운다 (보드 카드만. Slack 에는 아무것도 하지 않는다).
  "inbox.notRequest": { params: { id: string }; result: InboxState };
  // NOTES: 메모장. query 가 있으면 본문에 낱말이 모두 들어 있는 메모만 돌려준다. save 는 본문이 같으면 파일을 다시 쓰지 않고, 없는 id 는 거절한다(지운 메모가 다른 창의 저장으로 되살아나지 않게).
  // create 는 text 없이 부르면 빈 메모, delete 는 본문이 있으면 notes/.trash 로 옮기고 빈 메모는 그냥 지운다.
  "notes.list": { params: { query?: string }; result: Note[] };
  "notes.get": { params: { id: string }; result: NoteDoc };
  "notes.create": { params: { text?: string }; result: NoteDoc };
  "notes.save": { params: { id: string; text: string }; result: Note };
  "notes.delete": { params: { id: string }; result: null };
  "board.get": { params: Record<string, never>; result: Board };
  // Slack 알림 같은 바깥 입력도 이 형태로 카드를 만든다. 제목은 필수, 링크는 http(s) 만.
  "board.createCard": { params: NewCard; result: BoardCard };
  "board.updateCard": { params: { id: string; patch: CardPatch }; result: BoardCard };
  "board.deleteCard": { params: { id: string }; result: null };
  // index 는 이동한 카드를 뺀 목적지 열 안에서의 위치 (0 ~ 카드 수)
  "board.moveCard": { params: { id: string; columnId: string; index: number }; result: BoardCard };
  "board.linkAgent": { params: { cardId: string; agentId: string }; result: BoardCard };
  "board.unlinkAgent": { params: { cardId: string; agentId: string }; result: BoardCard };
  "board.addColumn": { params: { name: string }; result: BoardColumn };
  "board.renameColumn": { params: { id: string; name: string }; result: BoardColumn };
  // 카드가 있는 열을 지우면 카드는 바로 앞 열(첫 열이면 다음 열)의 끝으로 옮겨진다. 마지막 남은 열은 지울 수 없다.
  "board.deleteColumn": { params: { id: string }; result: null };
  "board.moveColumn": { params: { id: string; index: number }; result: null };
  // BOARDUX: 라벨 색을 팔레트 번호로 고정한다. color 가 null 이면 이름으로 정해지는 기본 색으로 되돌린다.
  "board.setLabelColor": { params: { label: string; color: number | null }; result: null };
  // MORNINGREVIEW: 최근 7일의 아침 리뷰. run 은 모델을 한 번 불러 만들 때까지 기다린다(오늘 것이 있으면 덮어쓴다). 이미 만드는 중이면 거절한다.
  "review.get": { params: Record<string, never>; result: ReviewState };
  // RELEASE: 설치된 버전, macOS 버전, 마지막으로 확인한 최신 릴리스, 닫은 버전. dismiss 는 그 버전의 사이드바 줄을 다시 띄우지 않는다.
  "release.get": { params: Record<string, never>; result: ReleaseState };
  "release.dismiss": { params: { version: string }; result: ReleaseState };
  "review.run": { params: Record<string, never>; result: ReviewState };
  // 이동 제안을 적용한다. cardIds 가 null 이면 아직 적용하지 않은 제안 전부. 그 사이 사용자가 카드를 옮겼거나 지웠으면 건너뛴다.
  "review.apply": { params: { date: string; cardIds: string[] | null }; result: { review: ReviewState; applied: number; skipped: number } };
  // 날짜의 자동 리뷰를 봤다고 표시한다(사이드바 점이 꺼진다)
  "review.markSeen": { params: { date: string }; result: ReviewState };
  // NOTION: 사이드바 Notion 묶음의 고정 페이지(~/.agent-nav/notion-pins.json). 바뀔 때마다 notionPins 이벤트가 목록 전체를 보낸다.
  "notion.pins.list": { params: Record<string, never>; result: NotionPin[] };
  // url 은 Notion 주소만. 같은 페이지가 이미 고정돼 있으면 새로 만들지 않고 그 항목을 돌려준다(added: false). icon 은 이모지 하나만 받고 그 밖에는 null 로 둔다.
  "notion.pins.add": { params: NotionPinInput; result: { pin: NotionPin; added: boolean } };
  "notion.pins.update": { params: { id: string; patch: NotionPinPatch }; result: NotionPin };
  "notion.pins.remove": { params: { id: string }; result: null };
  // index 는 옮기는 항목을 뺀 목록 안에서의 위치(0 ~ 항목 수)
  "notion.pins.move": { params: { id: string; index: number }; result: NotionPin[] };
  // NOTION2: Notion 화면. cached 는 마지막으로 읽어 둔 내용(네트워크 없음), read 는 Notion MCP 로 새로 읽는다.
  "notion.page.cached": { params: { url: string }; result: NotionPageView | null };
  "notion.page.read": { params: { url: string }; result: NotionPageView };
  // 페이지 전용 대화: 페이지마다 하나. start 는 페이지 내용을 컨텍스트로 가진 새 세션을 만들고(첫 메시지 prompt), reset 은 연결만 끊는다(세션은 남는다).
  "notion.chats.list": { params: Record<string, never>; result: Record<string, string> };
  "notion.chat.start": { params: { url: string; prompt: string; permissionMode: PermissionMode; model: string | null; effort: EffortLevel | null; images?: ImageRef[]; files?: FileRef[] }; result: Agent };
  "notion.chat.reset": { params: { url: string }; result: null };
  // MOBILE: 폰 앱용 타임라인 조각(끝에서 limit 개, beforeId 가 있으면 그 앞). 항목은 긴 도구 출력을 줄여 보낸다. 옛 agents.timeline 은 그대로다.
  "agents.timelinePage": { params: { agentId: string; limit: number; beforeId?: string }; result: TimelinePage };
  // MOBILE: 폰 앱의 왕복 시간 측정과 연결 확인
  "mobile.ping": { params: Record<string, never>; result: { now: number } };
  // MOBILE: Settings 의 Mobile access. 폰이 아니라 데스크톱 화면만 부른다(모바일 연결에는 허용되지 않는다).
  "mobile.status": { params: Record<string, never>; result: MobileStatus };
  "mobile.pairingCode": { params: Record<string, never>; result: PairingOffer };
  "mobile.revokeDevice": { params: { id: string }; result: MobileStatus };
  "import.vscodeList": { params: Record<string, never>; result: VscodeImportList };
  "import.vscodeRun": { params: { keys: string[] }; result: VscodeImportResult[] };
  "import.activity": { params: { agentId: string }; result: { active: boolean; lastWriteAt: string | null } };
  // SEARCHREPLACE: Search 뷰의 바꾸기. 치환 글은 화면이 계산해 보내고(shared/searchReplace.ts 의 replacementFor), 데몬은 파일마다 expected 가 지금 디스크와 같을 때만 전부 쓴다. 모바일에는 열지 않는다.
  "search.replace": { params: { workspaceId: string; files: ReplaceFileRequest[] }; result: { results: ReplaceFileResult[] } };
};

// NOTION2: 화면에 보내는 페이지 읽기 결과. enhanced 원문은 데몬만 갖는다.
export type NotionPageView = { page: Omit<NotionPageData, "enhanced">; fetchedAt: string; costUsd: number | null };

export type RpcMethod = keyof RpcMethods;

export type RpcRequest = { id: number; method: RpcMethod; params: unknown };

export type ServerEvent =
  | { type: "workspaces"; workspaces: Workspace[] }
  | { type: "sessionOrders"; orders: SessionOrders }
  | { type: "agent"; agent: Agent }
  | { type: "agentRemoved"; agentId: string }
  // VSCEXT: app.showAgent 의 알림. 세션 하나만 보이는 확장 화면은 무시한다.
  | { type: "showAgent"; agentId: string }
  | { type: "timelineUpsert"; agentId: string; item: TimelineItem }
  | { type: "timelineRemove"; agentId: string; itemId: string }
  | { type: "meta"; meta: Meta }
  // defaults 는 settings 와 함께 다시 해석한 기본값 (옛 데몬은 안 준다)
  | { type: "settings"; settings: Settings; defaults?: ResolvedDefaults }
  | { type: "changes"; agentId: string; changes: FileChange[] }
  // FIX4A: 보고 있는 폴더(workspaces.watch)의 파일이 바깥에서 바뀌었다. 화면이 Source Control 과 Changes 를 다시 읽는다.
  | { type: "workspaceChanged"; workspaceIds: string[] }
  | { type: "diffFeedback"; agentId: string; items: DiffFeedback[] }
  | { type: "quick"; run: QuickRun }
  | { type: "side"; run: SideRun }
  | { type: "termask"; run: TermAskRun }
  | { type: "feedback"; feedback: Feedback }
  | { type: "board"; board: Board }
  // MORNINGREVIEW: 아침 리뷰가 만들어지는 중이거나 끝났거나 실패했거나 이동이 적용됐다
  | { type: "review"; review: ReviewState }
  // RELEASE: 최신 릴리스를 새로 알았거나 사이드바 줄을 닫았다
  | { type: "release"; release: ReleaseState }
  // NOTES: 메모가 만들어지거나 바뀌거나 지워졌다. 최근 수정 순의 전체 목록이다(본문은 없다).
  | { type: "notes"; notes: Note[] }
  | { type: "notionPins"; pins: NotionPin[] }
  // NOTION2: 쓰기가 끝나 페이지가 바뀌었다(key 는 notionPageKey). 그 페이지를 보는 화면이 다시 읽는다.
  | { type: "notionChanged"; key: string }
  // NOTION2: 페이지 전용 대화 목록(페이지 키 -> 세션 id)
  | { type: "notionChats"; chats: Record<string, string> }
  // NOTION2: 에이전트의 start_work_session. 화면이 새 세션 초안을 연다.
  | { type: "notionStartSession"; agentId: string; prompt: string }
  | { type: "inbox"; inbox: InboxState }
  // 반영이 끝났으니 창을 다시 읽으라는 신호. restarting 이 아니면 화면이 입력이 멈춘 틈에 모아서 읽고(web/idleReload.ts), immediate 면 바로 읽는다(되돌리기)
  | { type: "reload"; restarting: boolean; immediate?: boolean }
  // G7: 에이전트가 공유된 Browser 탭에 도구를 부른다. 공유를 올린 그 화면에만 간다. 화면은 browser.toolResult 로 답한다.
  | { type: "browserTool"; id: string; agentId: string; pageId: string; tool: BrowserToolName; args: Record<string, unknown> }
  // G8: 에이전트의 open_browser_page. 그 세션을 보고 있는 화면이 Browser 탭을 열고(url 이 없으면 공유할 열린 탭을 묻고) browser.toolResult 로 답한다.
  | { type: "browserOpen"; id: string; agentId: string; url: string | null; forceNew: boolean };

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: ServerEvent };
