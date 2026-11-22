import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDraftDefaults } from "./defaults";
import { useDiffView } from "./diffMode";
import { Close, Codicon, Search } from "./icons";
import { rpc } from "./rpc";
import { SettingControl } from "./SettingsControls";
import { SETTING_DEFS, type FormatConfig, type SettingDef, type SettingsCtx } from "./settingsItems";
import { GROUP_ICONS, GROUP_IDS, activeGroup, filterSettings, groupCounts, isNarrow, type GroupId, type SettingMeta } from "./settingsSchema";
import { activeAgentOf } from "./activeAgentOf";
import { setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

type Section = "browser" | "import" | "format" | "mentions";
const SECTION_GROUP: Record<Section, GroupId> = { browser: "browser", import: "import", format: "formatting", mentions: "mentions" };

export function SettingsView() {
  const section = useStore((s) => (s.overlay?.kind === "status" ? s.overlay.section : undefined));
  const ctx = useSettingsCtx();
  const [dialogEl, setDialogEl] = useState<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const narrow = useNarrow(dialogEl);

  const metas = useMemo(() => (ctx ? SETTING_DEFS.map((def) => metaOf(def, ctx)) : []), [ctx]);
  const visible = useMemo(() => filterSettings(metas, query, modifiedOnly), [metas, query, modifiedOnly]);
  const counts = useMemo(() => groupCounts(visible), [visible]);
  const visibleIds = useMemo(() => new Set(visible.map((m) => m.id)), [visible]);
  const searching = query.trim() !== "" || modifiedOnly;
  const groups = GROUP_IDS.filter((id) => counts.has(id));

  return (
    <Dialog open onOpenChange={(open) => !open && setState({ overlay: null })}>
      <DialogContent
        ref={setDialogEl}
        label={S.settings}
        className="settings-dialog"
        data-narrow={narrow || undefined}
        onEscapeKeyDown={(event) => {
          if (query && (event.target as Element | null)?.closest?.(".settings-search")) event.preventDefault();
        }}
      >
        <SettingsSearch query={query} onQuery={setQuery} modifiedOnly={modifiedOnly} onModifiedOnly={setModifiedOnly} found={searching ? visible.length : null} onClose={() => setState({ overlay: null })} />
        {ctx && <SettingsBody ctx={ctx} groups={groups} counts={counts} visibleIds={visibleIds} searching={searching} modifiedOnly={modifiedOnly} section={section ? SECTION_GROUP[section] : undefined} />}
      </DialogContent>
    </Dialog>
  );
}

function SettingsSearch({ query, onQuery, modifiedOnly, onModifiedOnly, found, onClose }: { query: string; onQuery: (q: string) => void; modifiedOnly: boolean; onModifiedOnly: (on: boolean) => void; found: number | null; onClose: () => void }) {
  return (
    <div className="settings-head">
      <div className="settings-search">
        <Search size={14} />
        <input
          className="settings-search-input"
          aria-label={S.settingsSearch}
          placeholder={S.settingsSearch}
          value={query}
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              onQuery("");
            }
          }}
        />
        {found !== null && <span className="settings-count">{S.settingsFound(found)}</span>}
        {query && (
          <button type="button" className="settings-search-clear" aria-label={S.settingsClearSearch} onClick={() => onQuery("")}>
            <Codicon name="close" size={12} />
          </button>
        )}
      </div>
      <button type="button" className="settings-chip" aria-pressed={modifiedOnly} title={S.settingsModifiedOnlyTip} onClick={() => onModifiedOnly(!modifiedOnly)}>
        {S.settingsModifiedOnly}
      </button>
      <Button size="icon" aria-label={S.settingsClose} title={S.settingsClose} onClick={onClose}>
        <Close />
      </Button>
    </div>
  );
}

function SettingsBody({ ctx, groups, counts, visibleIds, searching, modifiedOnly, section }: { ctx: SettingsCtx; groups: GroupId[]; counts: Map<GroupId, number>; visibleIds: Set<string>; searching: boolean; modifiedOnly: boolean; section: GroupId | undefined }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<GroupId | null>(null);
  const pinned = useRef<GroupId | null>(null);

  const spy = () => {
    const el = scrollRef.current;
    if (!el || pinned.current) return;
    const tops = groups.map((id) => ({ id, top: el.querySelector<HTMLElement>(`[data-group="${id}"]`)?.offsetTop ?? 0 }));
    setCurrent(activeGroup(tops, el.scrollTop, SLACK, el.scrollTop + el.clientHeight >= el.scrollHeight - 1));
  };
  const go = (id: GroupId) => {
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (!el || !target) return;
    pinned.current = id;
    setCurrent(id);
    el.scrollTo({ top: target.offsetTop });
  };

  useEffect(spy, [groups.join(",")]);
  const jumped = useRef(false);
  useLayoutEffect(() => {
    if (section && !jumped.current && groups.includes(section)) {
      jumped.current = true;
      go(section);
    }
  });

  return (
    <div className="settings-body">
      <nav className="settings-toc" aria-label={S.settingsCategories}>
        {groups.map((id) => (
          <button key={id} type="button" className="side-item" aria-current={current === id || undefined} onClick={() => go(id)}>
            <Codicon name={GROUP_ICONS[id]} size={14} />
            <span className="settings-toc-name">{S.settingsGroups[id]}</span>
            {searching && <span className="settings-toc-count">{counts.get(id)}</span>}
          </button>
        ))}
      </nav>
      <div
        className="settings-scroll"
        ref={scrollRef}
        onScroll={spy}
        onWheel={() => (pinned.current = null)}
        onTouchMove={() => (pinned.current = null)}
        onKeyDown={() => (pinned.current = null)}
      >
        {groups.map((id) => (
          <SettingsGroup key={id} id={id} ctx={ctx} visibleIds={visibleIds} />
        ))}
        {groups.length === 0 && (
          <div className="settings-empty" role="status">
            <div>{S.settingsNoResults}</div>
            <div className="muted">{modifiedOnly ? S.settingsNoResultsHint : S.settingsNoResultsHintWord}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsGroup({ id, ctx, visibleIds }: { id: GroupId; ctx: SettingsCtx; visibleIds: Set<string> }) {
  const defs = SETTING_DEFS.filter((def) => def.group === id && visibleIds.has(def.id));
  return (
    <section className="settings-group" data-group={id}>
      <h2 className="settings-group-title">{S.settingsGroups[id]}</h2>
      <div className="settings-card">
        {defs.map((def) => (
          <SettingRow key={def.id} def={def} ctx={ctx} />
        ))}
      </div>
    </section>
  );
}

function SettingRow({ def, ctx }: { def: SettingDef; ctx: SettingsCtx }) {
  const modified = def.modified(ctx);
  const source = def.source?.(ctx) ?? null;
  const description = typeof def.description === "function" ? def.description(ctx) : def.description;
  return (
    <div className="setting-row" data-setting={def.id} data-modified={modified || undefined} data-wide={def.wide || undefined} data-kind={def.kind}>
      <div className="setting-text">
        <label className="setting-title" htmlFor={def.kind === "custom" ? undefined : `setting-${def.id}`}>
          {def.title}
          {source && <span className="setting-source">{source}</span>}
        </label>
        <div className="setting-desc">{description}</div>
        {def.extra === "release" && <ReleaseVersions />}
      </div>
      {modified && def.reset && (
        <button type="button" className="setting-reset" title={S.settingsResetTip(def.title)} onClick={() => def.reset?.(ctx)}>
          {S.settingsReset}
        </button>
      )}
      <div className="setting-control">
        <SettingControl def={def} ctx={ctx} />
      </div>
    </div>
  );
}

function ReleaseVersions() {
  const on = useStore((s) => s.settings?.notifyNewVersion === true);
  const release = useStore((s) => s.release);
  if (!on || !release?.latest) return null;
  const { url } = release.latest;
  return (
    <div className="setting-release">
      <span>{S.releaseVersions(release.installed, release.latest.version)}</span>
      <button type="button" className="setting-release-link" onClick={() => window.open(url, "_blank", "noopener")}>
        {S.releaseNotes}
      </button>
    </div>
  );
}

const SLACK = 24; // lint-tokens: allow 스크롤 계산용 숫자(space-6)

function metaOf(def: SettingDef, ctx: SettingsCtx): SettingMeta {
  return {
    id: def.id,
    group: def.group,
    groupLabel: S.settingsGroups[def.group],
    title: def.title,
    description: typeof def.description === "function" ? def.description(ctx) : def.description,
    keywords: def.keywords ?? "",
    modified: def.modified(ctx),
  };
}

function useSettingsCtx(): SettingsCtx | null {
  const settings = useStore((s) => s.settings);
  const defaults = useStore((s) => s.defaults);
  const meta = useStore((s) => s.meta);
  const draft = useDraftDefaults();
  const [diffView] = useDiffView();
  const format = useFormatConfig();
  return useMemo(() => (settings ? { settings, draft, defaults, diffView, format, models: meta?.models ?? [] } : null), [settings, draft, defaults, diffView, format, meta]);
}

function useFormatConfig() {
  const chosen = useStore((s) => s.settings?.formatOnSave ?? null);
  const chosenFormatters = useStore((s) => s.settings?.formatters ?? null);
  const workspaceId = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents)?.workspaceId ?? null);
  const [config, setConfig] = useState<FormatConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("format.config", workspaceId ? { workspaceId } : {})
      .then((value) => !cancelled && setConfig(value))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chosen, chosenFormatters, workspaceId]);
  return config;
}

function useNarrow(el: HTMLElement | null) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!el) return;
    const check = () => setNarrow(isNarrow(el.getBoundingClientRect().width));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return narrow;
}
