import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { countBySource, filterSkills, skillOpenTarget, sourceLabel, SKILL_FILTERS, type SkillCatalog, type SkillEntry, type SkillFilter } from "../shared/skills";
import { displayPath } from "./displayPath";
import { ChevronDown, ChevronUp, Refresh, Search } from "./icons";
import { rpc } from "./rpc";
import { flash, getState, openFile, setState } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";


const remembered: { query: string; filter: SkillFilter } = { query: "", filter: "all" };

const LONG_DESCRIPTION = 110;

type Load = { catalog: SkillCatalog | null; error: string | null; busy: boolean };

export function SkillsView() {
  const [load, setLoad] = useState<Load>({ catalog: null, error: null, busy: true });
  const [query, setQuery] = useState(remembered.query);
  const [filter, setFilter] = useState<SkillFilter>(remembered.filter);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    setLoad((l) => ({ ...l, busy: true }));
    rpc
      .call("skills.list", {})
      .then((catalog) => setLoad({ catalog, error: null, busy: false }))
      .catch((error: Error) => setLoad((l) => ({ catalog: l.catalog, error: /unknown method|not found/i.test(error.message) ? S.skillsNeedsDaemon : S.skillsLoadFailed(error.message), busy: false })));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const skills = load.catalog?.skills ?? [];
  const counts = useMemo(() => countBySource(skills), [skills]);
  const shown = useMemo(() => filterSkills(skills, query, filter), [skills, query, filter]);
  const byId = useMemo(() => new Map(skills.map((e) => [e.id, e])), [skills]);

  const changeQuery = (next: string) => {
    remembered.query = next;
    setQuery(next);
  };
  const changeFilter = (next: SkillFilter) => {
    remembered.filter = next;
    setFilter(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const row = (event.target as HTMLElement).closest<HTMLElement>(".skills-row");
    if (!row) return;
    event.preventDefault();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".skills-row") ?? []);
    rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  return (
    <section className="skills-view" aria-label={S.skills}>
      <div className="pane-header">
        <span className="agent-title">{S.skills}</span>
        {load.catalog && <span className="xs skills-count">{S.skillsCount(shown.length, skills.length)}</span>}
        <span className="spacer" />
        <Select value={filter} onValueChange={(v) => changeFilter(v as SkillFilter)}>
          <SelectTrigger aria-label={S.skillsFilter} title={S.skillsFilter}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SKILL_FILTERS.map((f) => (
              <SelectItem key={f} value={f}>
                {filterLabel(f, counts[f])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon" aria-label={S.skillsRefresh} title={S.skillsRefresh} disabled={load.busy} onClick={refresh}>
          <span className={load.busy ? "spin" : undefined}>
            <Refresh size={14} />
          </span>
        </Button>
      </div>
      <label className="skills-search">
        <Search size={14} />
        <input
          className="input"
          aria-label={S.skillsSearch}
          placeholder={S.skillsSearchPlaceholder}
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query && !e.nativeEvent.isComposing) {
              e.stopPropagation();
              changeQuery("");
            }
          }}
        />
      </label>
      {load.error && <div className="empty-hint">{load.error}</div>}
      {!load.error && !load.catalog && <div className="empty-hint">{S.skillsLoading}</div>}
      {load.catalog && (
        <div className="skills-list" role="list" aria-label={S.skillsAria} ref={listRef} onKeyDown={onKeyDown}>
          {shown.length === 0 && skills.length === 0 && (
            <div className="empty-hint">
              <div className="notes-empty">
                <span className="notes-empty-title">{S.skillsEmpty}</span>
                <span>{S.skillsEmptyBody}</span>
              </div>
            </div>
          )}
          {shown.length === 0 && skills.length > 0 && <div className="empty-hint">{S.skillsNoMatch}</div>}
          {shown.map((entry) => (
            <SkillRow key={entry.id} entry={entry} shadowedBy={entry.shadow ? byId.get(entry.shadow.id) : undefined} />
          ))}
        </div>
      )}
    </section>
  );
}

function filterLabel(filter: SkillFilter, count: number): string {
  if (filter === "user") return S.skillsFilterUser(count);
  if (filter === "project") return S.skillsFilterProject(count);
  if (filter === "plugin") return S.skillsFilterPlugin(count);
  if (filter === "account") return S.skillsFilterAccount(count);
  return S.skillsFilterAll(count);
}

function SkillRow({ entry, shadowedBy }: { entry: SkillEntry; shadowedBy: SkillEntry | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const long = entry.description.length > LONG_DESCRIPTION;
  const scope = entry.source.kind === "plugin" ? (entry.source.scope === "project" ? "project" : entry.source.scope === "synced" ? "synced" : "") : "";
  const shadowText = entry.shadow ? shadowLabel(entry, shadowedBy) : null;

  return (
    <div role="listitem" className="skills-item" data-shadowed={entry.shadow || entry.override === "off" || undefined}>
      <button type="button" className="skills-row" data-skill-id={entry.id} data-skill-name={entry.name} title={entry.path} onClick={() => openSkill(entry)}>
        <span className="skills-row-head">
          <span className="skills-row-name">{entry.name}</span>
          {entry.kind === "command" && <span className="skills-tag">{S.skillsCommand}</span>}
          {entry.override && (
            <span className="skills-tag" title={S.skillsOverrideTip}>
              {entry.override === "off" ? S.skillsOverrideOff : entry.override === "name-only" ? S.skillsOverrideNameOnly : S.skillsOverrideUserOnly}
            </span>
          )}
          {shadowText && <span className="skills-tag">{shadowText}</span>}
          <span className="skills-row-source" title={S.skillsSourceTip(sourceLabel(entry.source), scope)}>
            {sourceLabel(entry.source)}
          </span>
        </span>
        <span className="skills-row-desc" data-expanded={expanded || undefined}>
          {entry.description}
        </span>
        <span className="skills-row-path">
          {displayPath(entry.path)}
          {entry.realPath && displayPath(entry.realPath) !== displayPath(entry.path) ? ` → ${displayPath(entry.realPath)}` : ""}
        </span>
      </button>
      {long && (
        <Button size="icon" className="skills-expand" aria-expanded={expanded} aria-label={expanded ? S.skillsShowLess : S.skillsShowMore} title={expanded ? S.skillsShowLess : S.skillsShowMore} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </Button>
      )}
    </div>
  );
}

function shadowLabel(entry: SkillEntry, by: SkillEntry | undefined): string {
  if (entry.shadow?.reason === "skill-over-command") return S.skillsShadowCommand;
  const label = by ? sourceLabel(by.source) : "";
  return entry.shadow?.reason === "same-file" ? S.skillsShadowFile(label) : S.skillsShadowName(label);
}

function openSkill(entry: SkillEntry) {
  const state = getState();
  const target = skillOpenTarget(
    entry,
    state.workspaces.filter((w) => !w.feedback),
    state.activeWorkspaceId,
  );
  if (!target) {
    flash(S.skillsOpenFailed);
    return;
  }
  openFile(target);
  setState({ centerView: "sessions" });
}
