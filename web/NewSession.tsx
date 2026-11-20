import { Fragment, useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import { EmptyStart } from "./EmptyStart";
import { confirmAction } from "./ConfirmDialog";
import { agentsInFolder, removeFolderFromList } from "./workspaceActions";
import { Check, ChevronDown, Close, CommentDiscussion, Codicon, Folder, FolderCompact, BranchIcon, WorktreeCompact } from "./icons";
import { OpenFolderDialog } from "./OpenFolderDialog";
import { Popup } from "./Popup";
import { rpc } from "./rpc";
import { closePane, flash, isTopWorkspace, openAgent, refreshGit, rememberPick, setState, takePickFolderOnStart, useStore, withoutPaneDraft, type DraftSeed, type HandoffSeed } from "./store";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { BranchesResult, FileRef, Harness, ImageRef } from "../shared/protocol";
import { codexSupportsMode, CODEX_FALLBACK_MODE } from "../shared/codexPermission"; // CODEX
import { useCodexMeta } from "./harness"; // CODEX
import { useDraftDefaults } from "./defaults";
import { S } from "./strings";

type GitInfo = BranchesResult;

// 새 세션 화면(B3-13): 가운데 정렬. 위에 폴더 알약, 입력창, 입력창 아래 줄에 왼쪽 권한 모드와 오른쪽 위치(Branch 또는 New Worktree)와 브랜치.
// 제공자는 Claude 하나뿐이라 알약을 두지 않는다. 폴더 알약 목록의 Chat 을 고르면(workspaceId 가 null) 폴더 없는 퀵 챗(B6-02)이고, 위치 선택은 숨는다.
export function NewAgentView({ paneId, workspaceId, seed, handoff, closable }: { paneId: string; workspaceId: string | null; seed?: DraftSeed; handoff?: HandoffSeed; closable: boolean }) {
  const workspace = useStore((s) => (workspaceId ? s.workspaces.find((w) => w.id === workspaceId) : undefined));
  // HANDOFF: 핸드오프로 열렸으면 원 세션. 위치 선택이 그 세션의 폴더와 worktree 를 기준으로 한다.
  const source = useStore((s) => (handoff ? s.agents.find((a) => a.id === handoff.agentId) : undefined));
  const chat = workspaceId === null;
  // 모델과 effort 는 마지막으로 고른 값을 이어받는다. 권한은 설정값으로 시작한다.
  const draft = useDraftDefaults();
  const model = useStore((s) => s.draftModel[paneId]);
  const effort = useStore((s) => s.draftEffort[paneId]);
  // 새 세션 화면에서 바꾼 권한은 이 화면의 이번 세션에 쓰이고, 마지막으로 고른 값으로도 기억돼 다음 새 세션이 이어받는다. Settings 의 기본값은 바뀌지 않는다(버그 8).
  const mode = useStore((s) => s.draftPermission[paneId]);
  // CODEX: 이 칸에서 고른 도구(Claude 또는 Codex). 없으면 마지막으로 고른 값. 핸드오프는 Claude 세션 기록에서 만든 문서라 Claude 로만 시작한다.
  const pickedHarness = useStore((s) => s.draftHarness[paneId] ?? s.lastPicked.harness ?? "claude");
  const harness: Harness = handoff ? "claude" : pickedHarness;
  const codexMeta = useCodexMeta(harness);
  const lastCodexModel = useStore((s) => s.lastPicked.codexModel);
  const lastCodexEffort = useStore((s) => s.lastPicked.codexEffort);
  // 보드 카드의 "Start in Worktree" 로 열렸으면 worktree 와 카드 제목에서 만든 브랜치 이름으로 시작한다.
  const [place, setPlace] = useState<"here" | "worktree">(seed?.worktreeBranch != null ? "worktree" : "here");
  // 새 worktree 는 항상 원래 프로젝트(최상위 폴더)에서 만든다. worktree 세션의 폴더에서 다시 worktree 를 만들면 worktree 가 겹친다.
  const worktreeParent = workspace?.parentId ?? workspaceId;
  const [branch, setBranch] = useState(seed?.worktreeBranch ?? "");
  const [autoBranch] = useState(() => autoBranchName(new Date()));
  const [base, setBase] = useState("");
  const [git, setGit] = useState<GitInfo | null>(null);
  useEffect(() => {
    setGit(null);
    if (workspaceId === null) return;
    void rpc.call("git.branches", { workspaceId }).then((info) => {
      setGit(info);
      // 핸드오프의 새 worktree 는 원 세션이 일하던 브랜치에서 갈라진다
      const own = source?.worktree?.branch ?? info.current;
      setBase((b) => b || (handoff && own && info.branches.includes(own) ? own : info.defaultBase || info.branches[0] || ""));
    });
  }, [workspaceId]);
  // 훅은 아래 조기 return 보다 위에 둔다. 아래로 내려가면 폴더가 생기고 사라질 때 훅 수가 바뀌어 React 가 화면 전체를 내린다(#310).
  const branchRef = useRef<HTMLInputElement>(null);
  // FIX4A: 브랜치 이름의 문제(git check-ref-format 기준, 이미 있는 이름)를 입력하는 동안 입력란 아래에 보인다. 이름이 비면 안내하지 않는다(전송 때 막는다).
  const [problem, setProblem] = useState<string | null>(null);
  const checkName = place === "worktree" && branch.trim() !== "" && worktreeParent !== null;
  useEffect(() => {
    if (!checkName || worktreeParent === null) {
      setProblem(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void rpc
        .call("git.checkBranchName", { workspaceId: worktreeParent, branch: branch.trim() })
        .then((result) => !stale && setProblem(result.problem))
        .catch(() => !stale && setProblem(null));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [checkName, worktreeParent, branch]);
  // 폴더가 없거나 지워졌으면 빈 화면 대신 시작 안내를 보인다.
  if (!chat && !workspace) return <EmptyStart />;
  // CODEX: Codex 에 없는 모드(plan)로 시작하려 하면 가장 가까운 default 로 보인다. 모델과 effort 는 Codex 쪽 마지막 선택에서 시작하고, 없으면 Codex 가 config.toml 을 따른다.
  const rawMode = mode ?? draft.permissionMode;
  const permissionMode = harness === "codex" && !codexSupportsMode(rawMode) ? CODEX_FALLBACK_MODE : rawMode;
  const chosenModel = model === undefined ? (harness === "codex" ? (lastCodexModel ?? null) : draft.model) : model;
  const chosenEffort = effort === undefined ? (harness === "codex" ? (lastCodexEffort ?? null) : draft.effort) : effort;
  // config.toml 의 모델이 이 계정의 모델 목록에 없고 칩에서 모델을 고르지도 않았으면 보내도 거절될 수 있다(실제 확인: model_not_found)
  const missingDefault = harness === "codex" && !!codexMeta && chosenModel === null && !!codexMeta.defaultModel && codexMeta.models.length > 0 && !codexMeta.models.some((m) => m.value === codexMeta.defaultModel);
  // HEAD 가 아직 없는 레포(커밋 0개)라도 브랜치가 하나라도 있으면 그 브랜치를 기준으로 worktree 를 만들 수 있다.
  const canWorktree = !!git?.repoRoot && git.branches.length > 0;
  const worktreeDisabledReason = !git ? null : !git.repoRoot ? S.notGitRepo : git.branches.length === 0 ? S.repoNoCommits : null;
  // 브랜치 칸을 비워 두면 autoBranch(칸의 placeholder 로 보이는 이름)로 만든다. 이름을 꼭 넣게 막지 않는다(사용자 10-28).
  const worktreeParams = () => {
    if (chat || place !== "worktree") return null;
    if (problem) throw new Error(problem);
    if (!base) throw new Error(S.errBaseBranch);
    return { branch: branch.trim() || autoBranch, base };
  };
  // 브랜치 이름이 이미 있거나 형식이 틀렸으면 보내기 전에 막는다. 입력한 글은 그대로 두고 브랜치 칸으로 포커스를 옮긴다.
  const checkWorktree = () => {
    try {
      worktreeParams();
      return true;
    } catch (error) {
      flash((error as Error).message);
      if (problem) branchRef.current?.focus();
      return false;
    }
  };
  const create = async (prompt: string, from?: { sourceId: string; id: string; shown: string }, images?: ImageRef[], files?: FileRef[]) => {
    const worktree = worktreeParams();
    const agent = await rpc.call("agents.create", { workspaceId: worktree ? worktreeParent : workspaceId, prompt, permissionMode, model: chosenModel, effort: chosenEffort, worktree, ...(harness === "codex" ? { harness } : {}), ...(seed?.cardId ? { boardCardId: seed.cardId } : {}), ...(from ? { handoffFrom: from.sourceId, handoffId: from.id, shown: from.shown } : {}), ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}) });
    // 이 칸에서 고른 권한, 모델, effort 는 세션이 이어받았다. 같은 칸에 다시 새 세션 화면이 열리면 Settings 와 마지막으로 고른 값부터 다시 정한다.
    setState((s) => ({ draftPermission: withoutPaneDraft(s.draftPermission, paneId), draftModel: withoutPaneDraft(s.draftModel, paneId), draftEffort: withoutPaneDraft(s.draftEffort, paneId), draftHarness: withoutPaneDraft(s.draftHarness, paneId) }));
    return agent;
  };
  return (
    <section className="agent new-session" aria-label={S.newSessionAria(workspace?.name ?? S.chatPill)}>
      {closable && (
        <Button size="icon" className="new-session-close" aria-label={S.closePane} title={S.closePane} onClick={() => closePane(paneId)}>
          <Close />
        </Button>
      )}
      <div className="new-session-body">
        <div className="new-session-stack">
          <div className="new-session-pills">
            <FolderPill paneId={paneId} workspaceId={workspaceId} name={workspace?.name ?? S.chatPill} />
            {!handoff && <HarnessSwitch paneId={paneId} harness={harness} />}
          </div>
          {harness === "codex" && codexMeta && (!codexMeta.installed || !codexMeta.loggedIn || codexMeta.error || missingDefault) && (
            <div className="new-session-codex-note" role="status">
              {!codexMeta.installed ? S.codexNotInstalled : !codexMeta.loggedIn ? S.codexNotSignedIn : codexMeta.error ? S.codexLoadFailed(codexMeta.error) : S.codexDefaultModelMissing(codexMeta.defaultModel ?? "")}
            </div>
          )}
          <Composer
            paneId={paneId}
            agent={null}
            workspaceId={workspaceId}
            busy={false}
            permissionMode={permissionMode}
            onPermissionMode={(next) => {
              rememberPick({ permissionMode: next });
              setState((s) => ({ draftPermission: { ...s.draftPermission, [paneId]: next } }));
            }}
            model={chosenModel}
            activeModel={null}
            effort={chosenEffort}
            footerRight={chat ? undefined : <PlacePicker workspaceId={workspaceId} place={place} onPlace={setPlace} canWorktree={canWorktree} disabledReason={worktreeDisabledReason} git={git} onGit={(info) => setGit((prev) => (prev ? { ...prev, ...info } : info))} base={base} onBase={setBase} here={handoff ? (source?.worktree ? { title: S.handoffSameWorktree, description: S.handoffSameWorktreeDescription } : { title: S.handoffSameFolder, description: S.handoffSameFolderDescription }) : undefined} />}
            beforeSubmit={checkWorktree}
            onSubmit={async (prompt, options) => {
              const agent = await create(prompt, options.handoff ? { ...options.handoff, shown: options.shown ?? "" } : undefined, options.images, options.files);
              openAgent(agent.id);
            }}
            onSubmitBackground={async (prompt, images, files) => {
              await create(prompt, undefined, images, files);
            }}
          />
          {!chat && place === "worktree" && (
            <div className="new-session-fields">
              <label htmlFor={`branch-${paneId}`}>{S.branch}</label>
              <div className="new-session-branch">
                <input
                  id={`branch-${paneId}`}
                  ref={branchRef}
                  className="input mono"
                  placeholder={autoBranch}
                  value={branch}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? `branch-problem-${paneId}` : undefined}
                  onChange={(e) => setBranch(e.target.value.replace(/\s+/g, "-"))}
                />
                {problem && (
                  <span id={`branch-problem-${paneId}`} className="new-session-problem" role="alert">
                    {problem}
                  </span>
                )}
              </div>
              {git?.repoRoot && (
                <span className="faint xs mono new-session-hint">
                  {git.repoRoot.split("/").pop()}.worktrees/{branch || S.branchPlaceholder}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// 폴더 알약(B3-15). 누르면 검색, 등록된 폴더 목록, Open Folder... 가 나온다.
function FolderPill({ paneId, workspaceId, name }: { paneId: string; workspaceId: string | null; name: string }) {
  const [open, setOpen] = useState(false);
  const [openFolder, setOpenFolder] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  // New Window 로 연 빈 창이면 처음 한 번 폴더 목록을 펼친다(알약이 그려진 뒤라야 목록이 그 아래에 붙는다).
  useEffect(() => {
    if (takePickFolderOnStart()) setOpen(true);
  }, []);
  // 바깥에서 폴더를 넘겨받아(Open Folder, Dock) 칸의 폴더가 바뀌면 펼친 목록은 접는다.
  const shownFor = useRef(workspaceId);
  useEffect(() => {
    if (shownFor.current !== workspaceId) setOpen(false);
    shownFor.current = workspaceId;
  }, [workspaceId]);
  const select = (id: string | null) => {
    setOpen(false);
    if (id === workspaceId) return;
    setState((s) => ({ panes: s.panes.map((p) => (p.id === paneId && p.kind === "draft" ? { ...p, workspaceId: id } : p)), activeWorkspaceId: id ?? s.activeWorkspaceId }));
  };
  return (
    <>
      <button ref={pillRef} type="button" className="pill" aria-haspopup="listbox" aria-expanded={open} aria-label={S.folderPillAria(name)} onClick={() => setOpen((v) => !v)}>
        {workspaceId === null ? <CommentDiscussion /> : <FolderCompact />}
        <span>{name}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <FolderList
          anchor={pillRef.current}
          workspaceId={workspaceId}
          onSelect={select}
          onClose={() => setOpen(false)}
          onOpenFolder={() => {
            setOpen(false);
            setOpenFolder(true);
          }}
        />
      )}
      {openFolder && <OpenFolderDialog onClose={() => setOpenFolder(false)} onOpened={select} />}
    </>
  );
}

function FolderList({ anchor, workspaceId, onSelect, onClose, onOpenFolder }: { anchor: HTMLElement | null; workspaceId: string | null; onSelect: (id: string | null) => void; onClose: () => void; onOpenFolder: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = workspaces.filter(isTopWorkspace).filter((w) => !q || `${w.name} ${w.dir}`.toLowerCase().includes(q));
  return (
    <Popup anchor={anchor} placement="below" label={S.folderPillAria("")} className="popup-folder" onClose={onClose}>
      <input className="popup-input" autoFocus aria-label={S.foldersSearch} placeholder={S.foldersSearch} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && rows[0] && onSelect(rows[0].id)} />
      <div className="popup-list" role="listbox">
        {(!q || S.chatPill.toLowerCase().includes(q)) && (
          <div className="popup-row folder-row" role="option" aria-selected={workspaceId === null} data-chat onClick={() => onSelect(null)}>
            <span className="popup-check">{workspaceId === null && <Check size={12} />}</span>
            <CommentDiscussion size={14} />
            <span className="popup-row-title">{S.chatPill}</span>
            <span className="popup-row-detail">{S.chatPillDetail}</span>
          </div>
        )}
        {rows.map((w) => {
          // 세션이 있는 폴더도 뺄 수 있다(숨기고, 다시 추가하면 돌아온다). 도는 세션이 있으면 누를 때 이유를 알린다.
          const sessions = agentsInFolder(agents, w.id).length;
          return (
            <div key={w.id} className="popup-row folder-row" role="option" aria-selected={w.id === workspaceId} onClick={() => onSelect(w.id)}>
              <span className="popup-check">{w.id === workspaceId && <Check size={12} />}</span>
              <Folder size={14} />
              <span className="popup-row-title">{w.name}</span>
              <span className="popup-row-detail">{parentPath(w.dir)}</span>
              <button
                type="button"
                className="popup-row-action"
                aria-label={S.removeFolder}
                title={sessions ? S.removeFolderWithSessions(sessions) : S.removeFolder}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeFolderFromList(w);
                }}
              >
                <Close size={12} />
              </button>
            </div>
          );
        })}
        {rows.length === 0 && !(!q || S.chatPill.toLowerCase().includes(q)) && <div className="popup-empty">{S.noResults}</div>}
      </div>
      <div className="popup-separator" />
      <button type="button" className="popup-row" onClick={onOpenFolder}>
        <span className="popup-check" />
        <span className="popup-row-title">{S.openFolder}</span>
      </button>
    </Popup>
  );
}

// 입력창 아래 줄의 오른쪽(B3-14): 위치 종류(Branch 또는 New Worktree), 구분선, 브랜치. Branch 는 이미 이 컴퓨터에 있는 저장소에서 그대로 일하고,
// New Worktree 는 이 세션만의 복사본을 만든다. 그때 브랜치 이름은 아래 입력에서 정하고, 기준 브랜치는 여기서 고른다.
function PlacePicker({ workspaceId, place, onPlace, canWorktree, disabledReason, git, onGit, base, onBase, here }: { workspaceId: string | null; place: "here" | "worktree"; onPlace: (place: "here" | "worktree") => void; canWorktree: boolean; disabledReason: string | null; git: GitInfo | null; onGit: (info: GitInfo) => void; base: string; onBase: (base: string) => void; here?: { title: string; description: string } }) {
  return (
    <div className="place-picker">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="place-chip" aria-label={S.placePickAria}>
            {place === "worktree" ? <WorktreeCompact size={12} /> : <FolderCompact size={12} />}
            <span>{place === "worktree" ? S.placeNewWorktree : (here?.title ?? S.placeBranch)}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="place-menu">
          <DropdownMenuItem className="place-item" onSelect={() => onPlace("here")}>
            <span className="place-item-text">
              <span>{here?.title ?? S.placeBranch}</span>
              <span className="faint xs">{here?.description ?? S.placeBranchDescription}</span>
            </span>
            {place === "here" && <Check size={14} />}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canWorktree} className="place-item data-[disabled]:cursor-default data-[disabled]:text-fg-subtle" onSelect={() => onPlace("worktree")}>
            <span className="place-item-text">
              <span>{S.placeNewWorktree}</span>
              <span className="faint xs">{disabledReason ?? S.placeNewWorktreeDescription}</span>
            </span>
            {place === "worktree" && <Check size={14} />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="place-sep" aria-hidden="true" />
      {place === "worktree" && git ? (
        <Select value={base} onValueChange={onBase}>
          <SelectTrigger className="place-chip" aria-label={S.baseBranchAria}>
            <BranchIcon size={12} />
            <SelectValue placeholder={S.branch} />
          </SelectTrigger>
          <SelectContent>
            {git.branches.map((b) => (
              <SelectItem key={b} value={b} className="mono">
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <BranchChip workspaceId={workspaceId} git={git} onGit={onGit} />
      )}
    </div>
  );
}

// "here" 모드의 브랜치 칩. 누르면 검색 입력과 브랜치 목록이 열리고, 고르면 git switch 로 바로 바꾼다.
// Radix DropdownMenu 는 글자 입력을 항목 이름 찾기(typeahead)로 가로채 검색 입력과 겹쳐서, 폴더 알약과 첨부 목록이 쓰는 Popup 위에 만들었다.
// variant "title" 은 제목줄 브랜치 칩(web/TitleBranch.tsx)의 모양이다: codicon git-branch, 말줄임, 도구 설명.
export function BranchChip({ workspaceId, git, onGit, placement = "above", label, variant = "place", tooltip }: { workspaceId: string | null; git: GitInfo | null; onGit: (info: GitInfo) => void; placement?: "above" | "below"; label?: string; variant?: "place" | "title"; tooltip?: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setError(null);
    setOpen(true);
    // 다른 도구에서 만든 브랜치와 바뀐 uncommitted 수를 열 때마다 새로 읽는다
    if (workspaceId) void rpc.call("git.branches", { workspaceId }).then(onGit).catch(() => {});
  };
  const choose = async (branch: string) => {
    if (!workspaceId || switching) return;
    if (branch === git?.current) {
      setOpen(false);
      return;
    }
    setError(null);
    setSwitching(true);
    try {
      let result = await rpc.call("git.switchBranch", { workspaceId, branch });
      if (!result.switched) {
        // 응답 중인 세션이 있으면 대화상자를 먼저 받는다. 대화상자의 포인터 입력이 목록을 바깥 클릭으로 닫으니 목록을 먼저 닫는다.
        setOpen(false);
        if (!(await confirmAction(S.branchSwitchBusyTitle(branch), S.branchSwitchButton, S.branchSwitchBusyDetail(result.busy)))) return;
        result = await rpc.call("git.switchBranch", { workspaceId, branch, allowBusy: true });
      }
      onGit(result.info);
      setOpen(false);
      for (const agentId of result.affectedAgentIds) void refreshGit(agentId);
    } catch (e) {
      setError((e as Error).message);
      setOpen(true);
    } finally {
      setSwitching(false);
    }
  };
  return (
    <>
      <button ref={chipRef} type="button" className={variant === "title" ? "title-branch" : "place-chip"} aria-label={S.branchMenuAria} title={tooltip} aria-haspopup="listbox" aria-expanded={open} aria-busy={switching || undefined} onClick={toggle}>
        {switching ? <Codicon name="loading" size={variant === "title" ? 14 : 12} spin /> : variant === "title" ? <Codicon name="git-branch" size={14} /> : <BranchIcon size={12} />}
        <span>{label ?? git?.current ?? "-"}</span>
      </button>
      {open && <BranchPicker anchor={chipRef.current} placement={placement} git={git} error={error} onChoose={(branch) => void choose(branch)} onTyping={() => setError(null)} onClose={() => setOpen(false)} />}
    </>
  );
}

type BranchRow = { key: string; name: string; kind: "current" | "local" | "remote" };

function BranchPicker({ anchor, placement, git, error, onChoose, onTyping, onClose }: { anchor: HTMLElement | null; placement: "above" | "below"; git: GitInfo | null; error: string | null; onChoose: (branch: string) => void; onTyping: () => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = branchRows(git, query);
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [index, query]);
  return (
    <Popup anchor={anchor} placement={placement} align="end" label={S.branchSearch} className="popup-branch" onClose={onClose}>
      <input
        className="popup-input"
        autoFocus
        aria-label={S.branchSearch}
        placeholder={S.branchSearch}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
          onTyping();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, rows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (rows[index]) onChoose(rows[index].name);
          }
        }}
      />
      {error && (
        <div className="popup-error" role="alert">
          {error}
        </div>
      )}
      <div ref={listRef} className="popup-list" role="listbox" aria-label={S.branchSearch}>
        {rows.map((row, i) => (
          <Fragment key={row.key}>
            {row.kind !== "current" && rows[i - 1]?.kind !== row.kind && (
              <div className="popup-title" role="presentation">
                {row.kind === "local" ? S.branchGroupLocal : S.branchGroupRemote}
              </div>
            )}
            <button type="button" role="option" aria-selected={row.kind === "current"} className={row.kind === "current" ? "popup-row branch-current" : "popup-row"} data-active={i === index || undefined} data-branch={row.name} title={row.name} onMouseEnter={() => setIndex(i)} onClick={() => onChoose(row.name)}>
              {row.kind === "current" ? (
                <>
                  <span className="place-item-text">
                    <span className="popup-row-title">{row.name === "HEAD" ? S.branchDetached : row.name}</span>
                    <span className="faint xs">{S.uncommittedFiles(git?.uncommitted ?? 0)}</span>
                  </span>
                  <Check size={14} />
                </>
              ) : (
                <span className="popup-row-title">{row.name}</span>
              )}
            </button>
          </Fragment>
        ))}
        {rows.length === 0 && <div className="popup-empty">{!git ? S.loading : !git.repoRoot ? S.notGitRepo : S.noResults}</div>}
      </div>
    </Popup>
  );
}

function branchRows(git: GitInfo | null, query: string): BranchRow[] {
  if (!git?.repoRoot) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (name: string) => terms.every((term) => name.toLowerCase().includes(term));
  const locals = new Set(git.locals);
  const rows: BranchRow[] = [];
  if (git.current && matches(git.current === "HEAD" ? "Detached HEAD" : git.current)) rows.push({ key: `current:${git.current}`, name: git.current, kind: "current" });
  for (const name of git.locals) if (name !== git.current && matches(name)) rows.push({ key: `local:${name}`, name, kind: "local" });
  // origin/feature 는 로컬 feature 가 이미 있으면 같은 브랜치이니 숨긴다
  for (const ref of git.remotes) if (!locals.has(ref.slice(ref.indexOf("/") + 1)) && matches(ref)) rows.push({ key: `remote:${ref}`, name: ref, kind: "remote" });
  return rows;
}

function parentPath(dir: string) {
  const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
  return parent.replace(/^\/Users\/[^/]+/, "~");
}

// 브랜치 칸을 비워 둔 새 worktree 의 이름. 만든 시각을 초까지 넣어 겹치지 않게 한다(예: lodestar/20261028-153012).
export function autoBranchName(now: Date) {
  const two = (n: number) => String(n).padStart(2, "0");
  return `lodestar/${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

// CODEX: 새 세션을 돌릴 도구 선택(Claude, Codex). 고른 값은 다음 새 세션에도 이어진다. 바꾸면 이 칸의 모델과 effort 선택은 지운다(서로의 모델 id 가 섞이지 않게).
function HarnessSwitch({ paneId, harness }: { paneId: string; harness: Harness }) {
  const choose = (next: Harness) => {
    if (next === harness) return;
    rememberPick({ harness: next });
    setState((s) => ({ draftHarness: { ...s.draftHarness, [paneId]: next }, draftModel: withoutPaneDraft(s.draftModel, paneId), draftEffort: withoutPaneDraft(s.draftEffort, paneId) }));
  };
  return (
    <div className="harness-switch" role="radiogroup" aria-label={S.harnessAria}>
      {(["claude", "codex"] as const).map((value) => (
        <button key={value} type="button" role="radio" aria-checked={value === harness} aria-label={S.harnessPillAria(value === "claude" ? S.harnessClaude : S.harnessCodex)} data-harness={value} data-on={value === harness || undefined} onClick={() => choose(value)}>
          {value === "claude" ? S.harnessClaude : S.harnessCodex}
        </button>
      ))}
    </div>
  );
}
