import "./pr.css";
import { useEffect, useSyncExternalStore } from "react";
import { PR_QUERIES, type PrQueryName, type PrRepo, type PrSummary } from "../shared/prTypes";
import { CheckIcon, checkKindOf, PrAvatar, PrStateIcon, ReviewIcon, useNow } from "./PrBits";
import { ChevronDown, ChevronRight, More, Refresh } from "./icons";
import { openPr, PR_REFRESH_CHOICES, refreshLists, setCollapsed, setRefreshMinutes, startAutoRefresh, usePr } from "./prStore";
import { P } from "./prStrings";
import { SectionMoveItems } from "./SectionMoveItems";
import { relativeTime } from "./sessionList";
import { useStore } from "./store";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

// 사이드바의 Pull Requests 구역. GitHub Pull Requests 확장처럼 쿼리 묶음(Waiting For My Review, Assigned To Me, Created By Me, All Open)을 저장소별로 보인다.
export function PullRequestsSection() {
  const collapsed = usePr((s) => s.collapsed.section !== false);
  const status = usePr((s) => s.status);
  const lists = usePr((s) => s.lists);
  const loading = usePr((s) => s.statusLoading || Object.values(s.lists).some((l) => l.loading));
  const refreshMinutes = usePr((s) => s.refreshMinutes);
  const waiting = status?.repos.reduce((n, repo) => n + (lists[repo.fullName]?.data?.waiting.length ?? 0), 0) ?? 0;

  useEffect(() => startAutoRefresh(), []);

  return (
    <section className="pr-section" aria-label={P.sectionAria} data-collapsed={collapsed || undefined}>
      <div className="sessions-header pr-section-head">
        <button type="button" className="pr-section-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed("section", !collapsed)}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="sessions-title">{P.section}</span>
          {collapsed && waiting > 0 && (
            <span className="pr-count" title={P.query.waiting}>
              {waiting}
            </span>
          )}
        </button>
        <span className="spacer" />
        <Button size="icon" aria-label={P.refresh} title={P.refresh} onClick={() => void refreshLists()}>
          <Refresh className={loading ? "pr-spin" : undefined} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" aria-label={P.moreActions} title={P.moreActions}>
              <More />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="session-menu" data-menu="more">
            <div className="pr-menu-label">{P.autoRefresh}</div>
            <DropdownMenuRadioGroup value={String(refreshMinutes)} onValueChange={(value) => setRefreshMinutes(Number(value))}>
              {PR_REFRESH_CHOICES.map((minutes) => (
                <DropdownMenuRadioItem key={minutes} value={String(minutes)}>
                  {minutes === 0 ? P.autoRefreshOff : P.autoRefreshMinutes(minutes)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <SectionMoveItems id="pullRequests" />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!collapsed && <SectionBody />}
    </section>
  );
}

function SectionBody() {
  const status = usePr((s) => s.status);
  if (!status) return <div className="pr-note">{P.loading}</div>;
  if (!status.available) return <div className="pr-note" title={status.reason ?? ""}>{status.reason ?? P.unavailable}</div>;
  if (status.repos.length === 0) return <div className="pr-note">{status.reason ?? P.noRepos}</div>;
  // 저장소별로 나누지 않고 쿼리 묶음 하나에 모든 저장소의 PR 을 합친다(사용자 11-03 "리포별로 나누지 말자").
  return (
    <div className="pr-body">
      {PR_QUERIES.map((query) => (
        <QueryGroup key={query} repos={status.repos} query={query} />
      ))}
    </div>
  );
}

function QueryGroup({ repos, query }: { repos: PrRepo[]; query: PrQueryName }) {
  const key = `all:${query}`;
  const collapsed = usePr((s) => s.collapsed[key] ?? query !== "waiting");
  const lists = usePr((s) => s.lists);
  const loaded = repos.filter((repo) => lists[repo.fullName]?.data);
  const errors = repos.flatMap((repo) => {
    const error = lists[repo.fullName]?.error;
    return error ? [{ repo: repo.fullName, error }] : [];
  });
  // 최근에 바뀐 것부터. 저장소가 섞이니 저장소 안 순서 대신 updatedAt 으로 다시 늘어놓는다.
  const prs = loaded.flatMap((repo) => lists[repo.fullName]?.data?.[query] ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waitingAll = loaded.length === 0 && errors.length === 0;
  const now = useNow();
  return (
    <div className="session-group pr-query" data-collapsed={collapsed || undefined}>
      <div className="session-group-head" data-collapsed={collapsed || undefined}>
        <button type="button" className="session-group-main" aria-expanded={!collapsed} onClick={() => setCollapsed(key, !collapsed)}>
          <span className="session-group-name">{P.query[query]}</span>
          <span className="pr-count" data-quiet="">
            {loaded.length ? prs.length : ""}
          </span>
          <span className="session-group-chevron">{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
        </button>
      </div>
      {!collapsed &&
        errors.map(({ repo, error }) => (
          <div key={repo} className="pr-note" title={error}>
            {repos.length > 1 ? `${repo}: ${error}` : error}
          </div>
        ))}
      {!collapsed && waitingAll && <div className="pr-note">{P.loading}</div>}
      {!collapsed && loaded.length > 0 && prs.length === 0 && <div className="pr-note">{P.empty}</div>}
      {!collapsed && prs.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} query={query} now={now} showRepo={repos.length > 1} />)}
    </div>
  );
}

function PrRow({ pr, query, now, showRepo }: { pr: PrSummary; query: PrQueryName; now: number; showRepo: boolean }) {
  const inPrView = useStore((s) => s.centerView === "pr");
  const selected = usePr((s) => s.views.center?.ref.repo === pr.repo && s.views.center.ref.number === pr.number);
  const firstQuery = usePr((s) => PR_QUERIES.find((q) => s.lists[pr.repo]?.data?.[q]?.some((p) => p.number === pr.number)) ?? null);
  const picked = useSyncExternalStore(subscribePicked, getPicked);
  const pickedQuery = picked?.repo === pr.repo && picked.number === pr.number ? picked.query : firstQuery;
  const active = inPrView && selected && pickedQuery === query;
  const check = checkKindOf(pr.checks);
  return (
    <div className="session-row pr-row" data-depth="0" data-active={active || undefined}>
      <button
        type="button"
        className="session-item"
        aria-label={P.rowAria(pr.number, pr.title)}
        onClick={() => {
          setPicked({ repo: pr.repo, number: pr.number, query });
          openPr(pr.repo, pr.number);
        }}
      >
        <span className="session-status">
          <PrStateIcon pr={pr} />
        </span>
        <span className="session-text">
          <span className="session-title-line">
            <span className="session-title" title={pr.title}>
              {pr.title}
            </span>
          </span>
          <span className="session-detail">
            <PrAvatar user={pr.author} size={12} />
            {/* 저장소가 여럿이면 어느 저장소 PR 인지 번호 앞에 짧은 이름(app-client#13175)으로 붙인다 */}
            <span className="pr-row-meta" title={showRepo ? pr.repo : undefined}>
              {showRepo && pr.repo.slice(pr.repo.lastIndexOf("/") + 1)}#{pr.number} {pr.author?.login ?? ""}
            </span>
            {check && <CheckIcon kind={check} />}
            <ReviewIcon decision={pr.reviewDecision} />
            <span className="pr-row-time">{relativeTime(pr.updatedAt, now)}</span>
          </span>
        </span>
      </button>
    </div>
  );
}


// 사이드바에서 마지막으로 누른 PR 줄의 묶음. 줄 칠하기에만 쓰여서 저장하지 않는다.
type Picked = { repo: string; number: number; query: PrQueryName };
let picked: Picked | null = null;
const pickedListeners = new Set<() => void>();

function setPicked(next: Picked) {
  picked = next;
  for (const listener of pickedListeners) listener();
}

function subscribePicked(listener: () => void) {
  pickedListeners.add(listener);
  return () => {
    pickedListeners.delete(listener);
  };
}

function getPicked() {
  return picked;
}
