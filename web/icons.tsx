type IconProps = { size?: number; className?: string };

export function Codicon({ name, size = 16, className, spin }: IconProps & { name: string; spin?: boolean }) {
  return <span className={`codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}${className ? ` ${className}` : ""}`} style={size === 16 ? undefined : { fontSize: size }} aria-hidden="true" />;
}

const make = (name: string) =>
  function NavIcon({ size = 16, className }: IconProps) {
    return <Codicon name={name} size={size} className={className} />;
  };

// --- 기존 이름(다른 화면이 쓰는 것). 내부 모양만 codicon 으로 바뀌었다 ---

export const ChevronLeft = make("chevron-left");
export const ChevronRight = make("chevron-right");
export const ChevronDown = make("chevron-down");
export const ChevronUp = make("chevron-up");
export const Back = make("arrow-left");
export const Forward = make("arrow-right");
export const Plus = make("plus");
export const Close = make("close");
export const Stop = make("stop-circle");
export const Send = make("arrow-up-compact");
export const Split = make("split-horizontal");
export const Diff = make("diff-multiple");
export const Trash = make("trash");
export const External = make("link-external");
export const OpenExternal = make("link-external");
export const Paperclip = make("attach");
export const References = make("search");
export const Search = make("search");
export const Refresh = make("refresh");
export const Sync = make("sync");
export const Spark = make("sparkle");
export const Check = make("check");
export const Undo = make("discard");
export const InlineDiffIcon = make("diff-single");
export const SplitDiffIcon = make("diff-sidebyside");
export const Branch = make("git-branch");
export const Fork = make("repo-forked");
export const TerminalIcon = make("terminal");
export const PanelLeft = make("layout-sidebar-left");
export const PanelRight = make("layout-sidebar-right");
export const PanelBottom = make("layout-panel");
export const More = make("more");
export const Filter = make("filter");
export const Gear = make("gear");
export const Warning = make("warning");
export const Chat = make("comment");
export const Folder = make("folder");
export const FileIcon = make("file");
export const Pick = make("inspect");
export const FeedbackIcon = make("feedback");
export const BoardIcon = make("project");
export const NoteIcon = make("note"); // NOTES
export const SkillsIcon = make("library"); // SKILLS
export const LinkIcon = make("link");
export const Edit = make("edit");
export const Start = make("play");
export const TagIcon = make("tag");

// --- 입력창 칩 아이콘 ---
// 칩과 메뉴 항목이 같은 기호를 쓰도록 여기서 한 번만 정한다.

export const PermissionAsk = make("shield");
export const PermissionEdits = make("edit");
export const PermissionPlan = make("lightbulb");
export const PermissionBypass = make("warning");
export const PermissionAuto = make("sparkle");
export const ModelIcon = make("claude");


export const SidebarToggle = make("layout-sidebar-left");
export const SidebarToggleOff = make("layout-sidebar-left-off");
export const SecondarySidebarToggle = make("layout-sidebar-right");
export const SecondarySidebarToggleOff = make("layout-sidebar-right-off");
export const PanelBottomOff = make("layout-panel-off");
export const FolderCompact = make("folder-compact");
export const WorktreeCompact = make("worktree-compact");
export const BranchIcon = make("git-branch");
export const ChevronDownCompact = make("chevron-down-compact");
export const ChevronRightCompact = make("chevron-right-compact");
export const RadioTower = make("radio-tower");
export const Account = make("account");
export const Calendar = make("calendar");
export const Extensions = make("extensions");
export const CommentDiscussion = make("comment-discussion");
export const CircleSmallFilled = make("circle-small-filled");
export const CircleFilled = make("circle-filled");
export const Pin = make("pin");
export const TreeItemExpanded = make("chevron-down");
export const AddCompact = make("add-compact");
export const ArrowUpCompact = make("arrow-up-compact");
export const AgentMode = make("agent");
export const ShieldIcon = make("shield");
export const Lightbulb = make("lightbulb");
export const DiffMultiple = make("diff-multiple");
export const Copy = make("copy");
export const Tools = make("tools");
export const TerminalCompact = make("terminal-compact");
export const BookCompact = make("book-compact");
export const Newline = make("newline");
export const CloseSmall = make("close-small");
export const Files = make("files");
export const Add = make("add");
export const CodeReview = make("code-review");
export const Fold = make("fold");
export const GoToFile = make("go-to-file");
export const KebabMore = make("kebab-horizontal");

// --- B7-06: 점 스피너 ---
// 3x3 격자의 바깥 여덟 칸에 점이 놓이고 시계 방향으로 차례로 밝아진다. 모양과 속도는 styles.css 의 .dot-spinner 가 정한다.
// 진행 중은 파랑, 입력 필요는 노랑. size 는 상자 한 변(px)이다.

export function DotSpinner({ state = "running", size = 16, className }: IconProps & { state?: "running" | "waiting" }) {
  return (
    <span className={`dot-spinner${className ? ` ${className}` : ""}`} data-state={state} style={size === 16 ? undefined : { width: size, height: size }} aria-hidden="true">
      {DOT_SPINNER_CELLS.map((cell) => (
        <span key={cell} />
      ))}
    </span>
  );
}

const DOT_SPINNER_CELLS = [0, 1, 2, 3, 4, 5];

// --- 노력 수준 막대 ---

export const EFFORT_STEPS = 5;

// 막대 5칸. 단계 수만큼 채우고 나머지는 흐리게 둔다. level 이 0 이면 전부 빈 막대(기본값, Auto).
export function EffortBars({ level, size = 16 }: IconProps & { level: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {Array.from({ length: EFFORT_STEPS }, (_, i) => {
        const height = 3 + i * 2;
        return <rect key={i} x={1 + i * 3} y={14 - height} width={2} height={height} rx={0.5} fill="currentColor" opacity={i < level ? 1 : 0.3} />;
      })}
    </svg>
  );
}

// --- B4: 제목줄, 변경 패널 ---
export const ListIcon = make("list-flat");
export const Maximize = make("screen-full");
export const Minimize = make("screen-normal");
export const VSCodeIcon = make("vscode");
export const FilesIcon = make("files");

// --- FMT: 알림 카드의 심각도 아이콘 ---
export const InfoIcon = make("info");
export const ErrorIcon = make("error");

// fixB: 첨부 메뉴의 Image...
export const ImageFile = make("file-media");
