type IconProps = { size?: number; className?: string };

export function Codicon({ name, size = 16, className, spin }: IconProps & { name: string; spin?: boolean }) {
  return <span className={`codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}${className ? ` ${className}` : ""}`} style={size === 16 ? undefined : { fontSize: size }} aria-hidden="true" />;
}

const make = (name: string) =>
  function NavIcon({ size = 16, className }: IconProps) {
    return <Codicon name={name} size={size} className={className} />;
  };

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
export const NoteIcon = make("note");
export const LinkIcon = make("link");
export const Edit = make("edit");
export const Start = make("play");

export const PermissionAsk = make("shield");
export const PermissionEdits = make("edit");
export const PermissionPlan = make("lightbulb");
export const PermissionBypass = make("warning");
export const PermissionAuto = make("sparkle");
export const ModelIcon = make("claude");

export function ProviderIcon({ harness, size = 16 }: { harness: "claude" | "codex" | "antigravity"; size?: number }) {
  if (harness === "antigravity") {
    return (
      <span className="provider-mark provider-antigravity" data-small={size < 16 || undefined} aria-hidden="true">
        A
      </span>
    );
  }
  return <Codicon name={harness === "codex" ? "openai" : "claude"} size={size} className={`provider-${harness}`} />;
}


export const FolderCompact = make("folder-compact");
export const WorktreeCompact = make("worktree-compact");
export const BranchIcon = make("git-branch");
export const ChevronDownCompact = make("chevron-down-compact");
export const ChevronRightCompact = make("chevron-right-compact");
export const CommentDiscussion = make("comment-discussion");
export const CircleSmallFilled = make("circle-small-filled");
export const CircleFilled = make("circle-filled");
export const Pin = make("pin");
export const TreeItemExpanded = make("chevron-down");
export const AddCompact = make("add-compact");
export const ArrowUpCompact = make("arrow-up-compact");
export const DiffMultiple = make("diff-multiple");
export const Copy = make("copy");
export const Tools = make("tools");
export const TerminalCompact = make("terminal-compact");
export const BookCompact = make("book-compact");
export const Newline = make("newline");
export const CloseSmall = make("close-small");
export const Files = make("files");
export const GoToFile = make("go-to-file");

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

export const ListIcon = make("list-flat");
export const Maximize = make("screen-full");
export const Minimize = make("screen-normal");
export const VSCodeIcon = make("vscode");
export const FilesIcon = make("files");

export const InfoIcon = make("info");
export const ErrorIcon = make("error");

export const ImageFile = make("file-media");
