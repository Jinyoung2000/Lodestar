import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Composer } from "./Composer";
import { EmptyStart } from "./EmptyStart";
import { confirmAction } from "./ConfirmDialog";
import { agentsInFolder, removeFolderFromList } from "./workspaceActions";
import { Check, ChevronDown, Close, CommentDiscussion, Codicon, Folder, FolderCompact, BranchIcon, WorktreeCompact } from "./icons";
import { OpenFolderDialog } from "./OpenFolderDialog";
import { canPickFolder, createProject, pickFolder } from "./folderOpen";
import { Popup } from "./Popup";
import { rpc } from "./rpc";
import { closePane, finishSessionDraft, flash, isTopWorkspace, refreshGit, rememberPick, setState, takePickFolderOnStart, useStore, withoutPaneDraft, type DraftSeed, type HandoffSeed } from "./store";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { type BranchesResult, type FileRef, type Harness, type ImageRef, type Workspace } from "../shared/protocol";
import { parentDisplay } from "./sessionFolders";
import { codexSupportsMode, CODEX_FALLBACK_MODE } from "../shared/codexPermission";
import { toolStatus, useCustomProvider, usePaneProvider, useToolMeta } from "./harness";
import { useDraftDefaults } from "./defaults";
import { S } from "./strings";

type GitInfo = BranchesResult;
const EMPTY_IDS: string[] = [];

export function NewAgentView({ paneId, workspaceId, extraWorkspaceIds, seed, handoff, closable }: { paneId: string; workspaceId: string | null; extraWorkspaceIds?: string[]; seed?: DraftSeed; handoff?: HandoffSeed; closable: boolean }) {
  const draftPane = useStore((s) => s.panes.find((pane) => pane.id === paneId && pane.kind === "draft"));
  const workspace = useStore((s) => (workspaceId ? s.workspaces.find((w) => w.id === workspaceId) : undefined));
  const allWorkspaces = useStore((s) => s.workspaces);
  const extraIds = useMemo(() => (workspaceId ? (extraWorkspaceIds ?? []).filter((id) => allWorkspaces.some((w) => w.id === id)) : EMPTY_IDS), [workspaceId, extraWorkspaceIds, allWorkspaces]);
  const source = useStore((s) => (handoff ? s.agents.find((a) => a.id === handoff.agentId) : undefined));
  const chat = workspaceId === null;
  const draft = useDraftDefaults();
  const model = useStore((s) => s.draftModel[paneId]);
  const effort = useStore((s) => s.draftEffort[paneId]);
  const mode = useStore((s) => s.draftPermission[paneId]);
  const pickedHarness = useStore((s) => s.draftHarness[paneId] ?? s.lastPicked.harness ?? "claude");
  const harness: Harness = handoff ? "claude" : pickedHarness;
  const provider = useCustomProvider(usePaneProvider(paneId));
  const lastProviderModel = useStore((s) => (provider ? (s.lastPicked.providerModels?.[provider.id] ?? null) : null));
  const codexMeta = useToolMeta(harness);
  const claudeMissing = useStore((s) => s.meta?.claudeMissing === true);
  const lastCodexModel = useStore((s) => s.lastPicked.codexModel);
  const lastCodexEffort = useStore((s) => s.lastPicked.codexEffort);
  const lastAntigravityModel = useStore((s) => s.lastPicked.antigravityModel);
  const lastAntigravityEffort = useStore((s) => s.lastPicked.antigravityEffort);
  const lastCursorModel = useStore((s) => s.lastPicked.cursorModel);
  const lastCursorEffort = useStore((s) => s.lastPicked.cursorEffort);
  const [place, setPlace] = useState<"here" | "worktree">(seed?.worktreeBranch != null ? "worktree" : "here");
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
      const own = source?.worktree?.branch ?? info.current;
      setBase((b) => b || (handoff && own && info.branches.includes(own) ? own : info.defaultBase || info.branches[0] || ""));
    });
  }, [workspaceId]);
  const branchRef = useRef<HTMLInputElement>(null);
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
  if (!chat && !workspace) return <EmptyStart />;
  const rawMode = mode ?? draft.permissionMode;
  const permissionMode = harness === "codex" && !codexSupportsMode(rawMode) ? CODEX_FALLBACK_MODE : rawMode;
  const chosenModel = provider ? (model ?? lastProviderModel ?? provider.defaultModel) : model === undefined ? (harness === "codex" ? (lastCodexModel ?? null) : harness === "antigravity" ? (lastAntigravityModel ?? null) : harness === "cursor" ? (lastCursorModel ?? null) : draft.model) : model;
  const chosenEffort = provider ? null : effort === undefined ? (harness === "codex" ? (lastCodexEffort ?? null) : harness === "antigravity" ? (lastAntigravityEffort ?? null) : harness === "cursor" ? (lastCursorEffort ?? null) : draft.effort) : effort;
  const missingDefault = harness === "codex" && !!codexMeta && chosenModel === null && !!codexMeta.defaultModel && codexMeta.models.length > 0 && !codexMeta.models.some((m) => m.value === codexMeta.defaultModel);
  const canWorktree = !!git?.repoRoot && git.branches.length > 0;
  const worktreeDisabledReason = !git ? null : !git.repoRoot ? S.notGitRepo : git.branches.length === 0 ? S.repoNoCommits : null;
  const worktreeParams = () => {
    if (chat || place !== "worktree") return null;
    if (problem) throw new Error(problem);
    if (!base) throw new Error(S.errBaseBranch);
    return { branch: branch.trim() || autoBranch, base };
  };
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
    const agent = await rpc.call("agents.create", { workspaceId: worktree ? worktreeParent : workspaceId, prompt, permissionMode, model: chosenModel, effort: chosenEffort, worktree, ...(extraIds.length ? { extraWorkspaceIds: extraIds } : {}), ...(harness !== "claude" ? { harness } : {}), ...(provider ? { providerId: provider.id } : {}), ...(seed?.cardId ? { boardCardId: seed.cardId } : {}), ...(from ? { handoffFrom: from.sourceId, handoffId: from.id, shown: from.shown } : {}), ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}) });
    setState((s) => ({ draftPermission: withoutPaneDraft(s.draftPermission, paneId), draftModel: withoutPaneDraft(s.draftModel, paneId), draftEffort: withoutPaneDraft(s.draftEffort, paneId), draftHarness: withoutPaneDraft(s.draftHarness, paneId), draftProvider: withoutPaneDraft(s.draftProvider, paneId) }));
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
            <FolderPill paneId={paneId} workspaceId={workspaceId} extraIds={extraIds} name={workspace?.name ?? S.chatPill} />
          </div>
          {harness === "claude" && claudeMissing && (
            <div className="new-session-codex-note" role="status">
              {S.claudeNotInstalled}
            </div>
          )}
          {harness === "codex" && codexMeta && (!codexMeta.installed || !codexMeta.loggedIn || codexMeta.error || missingDefault) && (
            <div className="new-session-codex-note" role="status">
              {!codexMeta.installed ? S.codexNotInstalled : !codexMeta.loggedIn ? S.codexNotSignedIn : codexMeta.error ? S.codexLoadFailed(codexMeta.error) : S.codexDefaultModelMissing(codexMeta.defaultModel ?? "")}
            </div>
          )}
          {(harness === "antigravity" || harness === "cursor") && codexMeta && toolStatus(harness, codexMeta) && (
            <div className="new-session-codex-note" role="status">
              {toolStatus(harness, codexMeta)}
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
              if (draftPane) finishSessionDraft(draftPane, agent.id);
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

function FolderPill({ paneId, workspaceId, extraIds, name }: { paneId: string; workspaceId: string | null; extraIds: string[]; name: string }) {
  const [open, setOpen] = useState(false);
  const [openFolder, setOpenFolder] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const workspaces = useStore((s) => s.workspaces);
  useEffect(() => {
    if (takePickFolderOnStart()) setOpen(true);
  }, []);
  const shownFor = useRef(workspaceId);
  useEffect(() => {
    if (shownFor.current !== workspaceId) setOpen(false);
    shownFor.current = workspaceId;
  }, [workspaceId]);
  const select = (id: string | null) => {
    setOpen(false);
    if (id === workspaceId && extraIds.length === 0) return;
    setState((s) => ({ panes: s.panes.map((p) => (p.id === paneId && p.kind === "draft" ? { ...p, workspaceId: id, extraWorkspaceIds: undefined } : p)), activeWorkspaceId: id ?? s.activeWorkspaceId }));
  };
  const extraNames = extraIds.flatMap((id) => workspaces.find((w) => w.id === id)?.name ?? []);
  return (
    <>
      <button ref={pillRef} type="button" className="pill" aria-haspopup="listbox" aria-expanded={open} aria-label={S.folderPillAria([name, ...extraNames].join(", "))} onClick={() => setOpen((v) => !v)}>
        {workspaceId === null ? <CommentDiscussion /> : <FolderCompact />}
        <span>{name}</span>
        {extraNames.length > 0 && <span className="pill-extra">+{extraNames.length}</span>}
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
            if (!canPickFolder()) return setOpenFolder(true);
            void pickFolder().then((workspace) => workspace && select(workspace.id));
          }}
          onNewProject={() => {
            setOpen(false);
            void createProject().then((workspace) => workspace && select(workspace.id));
          }}
        />
      )}
      {openFolder && <OpenFolderDialog onClose={() => setOpenFolder(false)} onOpened={select} />}
    </>
  );
}

type FolderEntry = { kind: "chat" } | { kind: "folder"; workspace: Workspace; chosen: boolean };

function FolderList({ anchor, workspaceId, onSelect, onClose, onOpenFolder, onNewProject }: { anchor: HTMLElement | null; workspaceId: string | null; onSelect: (id: string | null) => void; onClose: () => void; onOpenFolder: () => void; onNewProject: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();
  const top = workspaces.filter(isTopWorkspace);
  const current = workspaces.find((w) => w.id === workspaceId);
  const matches = (w: Workspace) => !q || `${w.name} ${w.dir}`.toLowerCase().includes(q);
  const chosenEntries: FolderEntry[] = current && matches(current) ? [{ kind: "folder", workspace: current, chosen: true }] : [];
  const otherEntries: FolderEntry[] = top.filter((w) => w.id !== workspaceId && matches(w)).map((w) => ({ kind: "folder", workspace: w, chosen: false }));
  const showChat = !q || S.chatPill.toLowerCase().includes(q);
  const entries: FolderEntry[] = [...(showChat ? [{ kind: "chat" as const }] : []), ...chosenEntries, ...otherEntries];
  const active = Math.min(index, Math.max(entries.length - 1, 0));
  const pick = (entry: FolderEntry | undefined) => {
    if (entry) onSelect(entry.kind === "chat" ? null : entry.workspace.id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(entries.length ? (active + (e.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(entries[active]);
    }
  };
  const row = (entry: FolderEntry, i: number) => {
    if (entry.kind === "chat") {
      return (
        <div key="chat" className="popup-row folder-row" role="option" aria-selected={workspaceId === null} data-active={i === active || undefined} data-chat onMouseEnter={() => setIndex(i)} onClick={() => onSelect(null)}>
          <span className="popup-check">{workspaceId === null && <Check size={12} />}</span>
          <CommentDiscussion size={14} />
          <span className="popup-row-title">{S.chatPill}</span>
          <span className="popup-row-detail">{S.chatPillDetail}</span>
        </div>
      );
    }
    const w = entry.workspace;
    const sessions = agentsInFolder(agents, w.id).length;
    const prev = entries[i - 1];
    const separated = !!prev && (prev.kind === "chat" || prev.chosen !== entry.chosen);
    return (
      <Fragment key={w.id}>
        {separated && <div className="popup-separator" role="separator" />}
        <div className="popup-row folder-row" role="option" aria-selected={entry.chosen} data-active={i === active || undefined} onMouseEnter={() => setIndex(i)} onClick={() => onSelect(w.id)}>
          <span className="popup-check">{entry.chosen && <Check size={12} />}</span>
          <Folder size={14} />
          <span className="popup-row-title">{w.name}</span>
          <span className="popup-row-detail folder-row-where">{parentDisplay(w.dir)}</span>
          {!entry.chosen && (
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
          )}
        </div>
      </Fragment>
    );
  };
  return (
    <Popup anchor={anchor} placement="below" label={S.folderPillAria("")} className="popup-folder" onClose={onClose}>
      <input
        className="popup-input"
        autoFocus
        aria-label={S.foldersSearch}
        placeholder={S.foldersSearch}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="popup-list" role="listbox">
        {entries.map(row)}
        {entries.length === 0 && <div className="popup-empty">{S.noResults}</div>}
      </div>
      <div className="popup-separator" />
      <button type="button" className="popup-row" onClick={onOpenFolder}>
        <span className="popup-check" />
        <span className="popup-row-title">{S.openFolder}</span>
      </button>
      <button type="button" className="popup-row" onClick={onNewProject}>
        <span className="popup-check" />
        <span className="popup-row-title">{S.newProject}</span>
      </button>
    </Popup>
  );
}

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
  for (const ref of git.remotes) if (!locals.has(ref.slice(ref.indexOf("/") + 1)) && matches(ref)) rows.push({ key: `remote:${ref}`, name: ref, kind: "remote" });
  return rows;
}


export function autoBranchName(now: Date) {
  const two = (n: number) => String(n).padStart(2, "0");
  return `lodestar/${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}
