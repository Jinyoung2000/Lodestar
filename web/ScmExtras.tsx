import { useEffect, useState } from "react";
import { scmBasename, scmDirname, type ScmCommit, type ScmCommitFile, type ScmRepoWorktrees, type ScmTarget } from "../shared/scm";
import { FileTypeIcon } from "./FileTypeIcon";
import { ChevronRight, Codicon } from "./icons";
import { rpc } from "./rpc";
import { toggleScmSection, useScmView, type ScmSection } from "./scmState";
import { M } from "./scmStrings";
import { relativeTime } from "./sessionList";
import { flash, getState, startDraft, useStore } from "./store";

// SCM: Source Control 보기 아래의 Worktrees 와 Graph 구역.

export function ScmWorktrees({ currentRoot, refreshKey }: { currentRoot: string; refreshKey: string }) {
  const collapsed = useScmView((v) => !!v.collapsed.worktrees);
  // 작업 폴더를 더하거나 빼도 목록이 달라진다
  const workspaceCount = useStore((s) => s.workspaces.length);
  const repos = useLoaded(false, `${refreshKey}|${workspaceCount}`, () => rpc.call("scm.worktrees", {}));
  const count = repos?.reduce((n, r) => n + r.worktrees.length, 0) ?? null;
  return (
    <section className="scm-section" aria-label={M.worktrees}>
      <SectionHead section="worktrees" title={M.worktrees} count={count} />
      {!collapsed && repos && repos.length === 0 && <div className="scm-hint">{M.noWorktrees}</div>}
      {!collapsed && repos?.map((repo) => <RepoWorktrees key={repo.root} repo={repo} currentRoot={currentRoot} showName={repos.length > 1} />)}
    </section>
  );
}

function RepoWorktrees({ repo, currentRoot, showName }: { repo: ScmRepoWorktrees; currentRoot: string; showName: boolean }) {
  return (
    <>
      {showName && (
        <div className="scm-repo-name">
          <Codicon name="repo" />
          <span title={repo.root}>{repo.name}</span>
        </div>
      )}
      {repo.worktrees.map((worktree) => {
        const current = worktree.path === currentRoot;
        const label = worktree.branch ?? M.worktreeDetached(worktree.head);
        return (
          <button
            key={worktree.path}
            type="button"
            className="scm-row scm-worktree"
            data-current={current || undefined}
            title={`${worktree.path}\n${worktree.upstream ? M.upstreamOf(worktree.upstream) : ""}\n${current ? M.worktreeCurrent : M.worktreeOpen}`.trim()}
            onClick={() => void openWorktree(worktree.path)}
          >
            <Codicon name={worktree.main ? "repo" : "worktree"} />
            <span className="scm-name">{label}</span>
            {!worktree.main && <span className="scm-dir">{scmBasename(worktree.path)}</span>}
            <ScmCounts ahead={worktree.ahead} behind={worktree.behind} />
            <span className="scm-status" aria-hidden="true">
              {current && <Codicon name="check" />}
            </span>
          </button>
        );
      })}
    </>
  );
}

async function openWorktree(path: string) {
  try {
    const { workspaceId } = await rpc.call("scm.openWorktree", { path });
    const { panes, activePaneId } = getState();
    startDraft(workspaceId, panes.find((p) => p.id === activePaneId)?.kind === "draft" ? "active" : "new");
  } catch (error) {
    flash(M.openWorktreeFailed((error as Error).message), "error");
  }
}

function ScmCounts({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null;
  return (
    <span className="scm-counts" title={M.aheadBehind(ahead, behind)}>
      {ahead > 0 && (
        <span>
          <Codicon name="arrow-up" size={12} />
          {ahead}
        </span>
      )}
      {behind > 0 && (
        <span>
          <Codicon name="arrow-down" size={12} />
          {behind}
        </span>
      )}
    </span>
  );
}

// --- Graph ---

const GRAPH_LIMIT = 50;

export function ScmGraph({ target, refreshKey }: { target: ScmTarget; refreshKey: string }) {
  const collapsed = useScmView((v) => !!v.collapsed.graph);
  const commits = useLoaded(collapsed, refreshKey, () => rpc.call("scm.graph", { ...target, limit: GRAPH_LIMIT }));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="scm-section" aria-label={M.graph}>
      <SectionHead section="graph" title={M.graph} count={commits?.length ?? null} />
      {!collapsed && commits && commits.length === 0 && <div className="scm-hint">{M.noCommits}</div>}
      {!collapsed &&
        commits?.map((commit) => (
          <div key={commit.hash} role="group">
            <CommitRow commit={commit} open={open === commit.hash} onToggle={() => setOpen(open === commit.hash ? null : commit.hash)} />
            {open === commit.hash && <CommitFiles target={target} commit={commit} />}
          </div>
        ))}
    </section>
  );
}

function CommitRow({ commit, open, onToggle }: { commit: ScmCommit; open: boolean; onToggle: () => void }) {
  const shown = commit.refs.slice(0, 2);
  return (
    <button type="button" className="scm-row scm-commit-row" aria-expanded={open} aria-label={M.commitRowAria(commit.subject)} title={`${commit.short} ${commit.subject}\n${commit.author}, ${new Date(commit.date).toLocaleString()}`} onClick={onToggle}>
      <Codicon name={commit.parents > 1 ? "git-merge" : "git-commit"} />
      <span className="scm-commit-text">
        <span className="scm-commit-line">
          <span className="scm-name">{commit.subject}</span>
          {shown.length > 0 && (
            <span className="scm-refs">
              {shown.map((ref) => (
                <span key={ref} className="scm-ref" data-remote={ref.includes("/") || undefined}>
                  {ref}
                </span>
              ))}
              {commit.refs.length > shown.length && <span className="scm-ref">+{commit.refs.length - shown.length}</span>}
            </span>
          )}
        </span>
        <span className="scm-commit-meta">
          <span className="mono">{commit.short}</span>
          <span className="scm-author">{commit.author}</span>
          <span>{relativeTime(commit.date, Date.now())}</span>
        </span>
      </span>
    </button>
  );
}

function CommitFiles({ target, commit }: { target: ScmTarget; commit: ScmCommit }) {
  const files = useLoaded(false, commit.hash, () => rpc.call("scm.commitFiles", { ...target, hash: commit.hash }));
  const [picked, setPicked] = useState<string | null>(null);
  if (!files) return <div className="scm-hint scm-nested">{M.loadingFiles}</div>;
  return (
    <>
      {commit.parents > 1 && <div className="scm-hint scm-nested">{M.mergeCommit}</div>}
      {files.length === 0 && <div className="scm-hint scm-nested">{M.noFilesInCommit}</div>}
      {files.map((file) => (
        <div key={file.rel} role="group">
          <CommitFileRow file={file} open={picked === file.rel} onToggle={() => setPicked(picked === file.rel ? null : file.rel)} />
          {picked === file.rel && <CommitDiff target={target} hash={commit.hash} file={file} />}
        </div>
      ))}
    </>
  );
}

function CommitFileRow({ file, open, onToggle }: { file: ScmCommitFile; open: boolean; onToggle: () => void }) {
  const name = scmBasename(file.rel);
  const dir = scmDirname(file.rel);
  return (
    <button type="button" className="scm-row scm-nested scm-file" data-s={file.code} aria-expanded={open} title={file.from ? `${file.rel} (${M.renamedFrom(file.from)})` : file.rel} onClick={onToggle}>
      <FileTypeIcon name={name} />
      <span className="scm-name">{name}</span>
      {dir && <span className="scm-dir">{dir}</span>}
      <span className="scm-delta">
        <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
      </span>
      <span className="scm-status" data-s={file.code} title={M.statusName[file.code]}>
        {file.code}
      </span>
    </button>
  );
}

function CommitDiff({ target, hash, file }: { target: ScmTarget; hash: string; file: ScmCommitFile }) {
  const diff = useLoaded(false, `${hash}:${file.rel}`, () => rpc.call("scm.commitDiff", { ...target, hash, rel: file.rel, from: file.from }));
  if (!diff) return <div className="scm-hint scm-nested">{M.loadingDiff}</div>;
  const lines = diffLines(diff.text);
  return (
    <div className="scm-diff-wrap scm-nested">
      {lines.length === 0 && <div className="scm-hint">{M.noDiffText}</div>}
      {lines.length > 0 && (
        <pre className="scm-diff">
          {lines.map((line, index) => (
            <span key={index} className="scm-diff-line" data-k={line.kind}>
              {line.text || " "}
            </span>
          ))}
        </pre>
      )}
      {diff.truncated && <div className="scm-hint">{M.diffTruncated}</div>}
    </div>
  );
}

type DiffLine = { kind: "add" | "del" | "hunk" | "ctx" | "note"; text: string };

// unified diff 의 파일 머리(diff --git, index, ---, +++)는 빼고 @@ 부터 보인다
function diffLines(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let started = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      started = true;
      lines.push({ kind: "hunk", text: line });
    } else if (!started) {
      if (/^Binary files /.test(line)) lines.push({ kind: "note", text: line });
    } else if (line.startsWith("+")) lines.push({ kind: "add", text: line });
    else if (line.startsWith("-")) lines.push({ kind: "del", text: line });
    else if (line.startsWith("\\")) lines.push({ kind: "note", text: line });
    else if (line !== "" || lines.length > 0) lines.push({ kind: "ctx", text: line });
  }
  while (lines.length > 0 && lines[lines.length - 1].kind === "ctx" && lines[lines.length - 1].text === "") lines.pop();
  return lines;
}

// --- 공통 ---

function SectionHead({ section, title, count }: { section: ScmSection; title: string; count: number | null }) {
  const collapsed = useScmView((v) => !!v.collapsed[section]);
  return (
    <div className="scm-section-head">
      <button type="button" className="scm-section-toggle" aria-expanded={!collapsed} onClick={() => toggleScmSection(section)}>
        <span className="scm-chev" data-collapsed={collapsed || undefined}>
          <ChevronRight />
        </span>
        <span className="scm-section-title">{title}</span>
      </button>
      {count !== null && <span className="scm-count">{count}</span>}
    </div>
  );
}

// 펼쳐져 있는 동안 key 가 바뀔 때마다 다시 읽는다. 접혀 있으면 읽지 않는다. 읽는 중에도 이전 값을 보여 준다(깜빡임 없이).
function useLoaded<T>(skip: boolean, key: string, load: () => Promise<T>): T | null {
  const [value, setValue] = useState<{ key: string; data: T } | null>(null);
  useEffect(() => {
    if (skip) return;
    let live = true;
    load()
      .then((data) => live && setValue({ key, data }))
      .catch((error: Error) => live && flash(M.statusFailed(error.message), "error"));
    return () => {
      live = false;
    };
    // load 는 key 로 식별되는 같은 호출이다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, key]);
  return value?.data ?? null;
}
