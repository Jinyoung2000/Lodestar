import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type EffortLevel, type ModelInfo } from "../shared/protocol";
import { effortName } from "./Composer";
import { builtinEffort, supportedLevels } from "./effortLevels";
import { Check, ChevronDown, ChevronRight, Pin } from "./icons";
import { Popup } from "./Popup";
import { getState, useStore } from "./store";
import { S } from "./strings";
import { currentDefaults } from "./defaults";
import { announce } from "./announce";
import { claimKeys } from "./shortcuts";
import { activeHarness, codexLevels, toolMetaOf } from "./harness";
import { applyEffort, currentModelAndEffort, setModelPin } from "./modelPick";

type ModelMenuProps = {
  anchor: HTMLElement | null;
  current: string;
  onChoose: (value: string, asDefault: boolean, group: string | null) => void;
  onClose: () => void;
  groups?: readonly ModelGroup[];
  currentGroup?: string | null;
};

export type ModelGroup = { key: string; name: string; models: readonly { value: string; name: string }[] };

type EffortMenuProps = {
  anchor: HTMLElement | null;
  label: string;
  levels: readonly EffortLevel[];
  current: EffortLevel | null;
  onChoose: (level: EffortLevel) => void;
  onClose: () => void;
};

export function EffortMenu({ anchor, label, levels, current, onChoose, onClose }: EffortMenuProps) {
  return (
    <Popup anchor={anchor} placement="above" label={label} className="popup-effort" onClose={onClose}>
      <div className="popup-list" role="listbox">
        {levels.map((level) => (
          <div
            key={level}
            className="popup-row"
            role="option"
            aria-selected={level === current}
            onClick={() => {
              onChoose(level);
              onClose();
            }}
          >
            <span className="popup-check">{level === current && <Check size={12} />}</span>
            <span className="popup-row-title">{effortName(level)}</span>
          </div>
        ))}
      </div>
    </Popup>
  );
}

export function ModelMenu({ anchor, current, onChoose, onClose, groups = [], currentGroup = null }: ModelMenuProps) {
  const meta = useStore((s) => s.meta);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [othersOpen, setOthersOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<readonly string[]>(currentGroup ? [currentGroup] : []);
  const modelPins = useStore((s) => s.modelPins);
  const pinned = modelPins ?? [];
  const models = meta?.models ?? [];
  const q = query.trim().toLowerCase();

  const claudeCurrent = currentGroup ? null : current;
  const currentValue = claudeCurrent === null ? undefined : models.find((m) => modelMatches(m, claudeCurrent))?.value;
  const top = currentValue && !pinned.includes(currentValue) ? [...pinned, currentValue] : pinned;
  const grouped = top.length > 0 && !q;
  const { pinnedEntries, otherEntries } = useMemo(() => {
    const matches = q ? models.filter((m) => `${m.displayName} ${m.value} ${m.resolvedModel ?? ""}`.toLowerCase().includes(q)) : models;
    const toEntry = (model: ModelInfo): Entry => ({ kind: "model", model });
    const pinnedEntries = grouped ? matches.filter((m) => top.includes(m.value)).map(toEntry) : [];
    const otherEntries = (grouped ? matches.filter((m) => !top.includes(m.value)) : matches).map(toEntry);
    const known = models.some((m) => [m.value, m.displayName, m.resolvedModel].some((v) => v?.toLowerCase() === q)) || groups.some((g) => g.models.some((m) => [m.value, m.name].some((v) => v.toLowerCase() === q)));
    if (q && !known && /^[\w.[\]:/-]+$/.test(query.trim())) otherEntries.push({ kind: "custom", value: query.trim() });
    return { pinnedEntries, otherEntries };
  }, [models, groups, q, query, top, grouped]);
  const shownGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          group,
          entries: group.models.filter((m) => !q || `${m.name} ${m.value} ${group.name}`.toLowerCase().includes(q)).map((m): Entry => ({ kind: "group", group: group.key, value: m.value, name: m.name })),
        }))
        .filter((shown) => shown.entries.length > 0),
    [groups, q],
  );
  const groupOpen = (key: string) => !!q || openGroups.includes(key);
  const toggleGroup = (key: string) => setOpenGroups((open) => (open.includes(key) ? open.filter((other) => other !== key) : [...open, key]));
  const empty = meta?.error ? S.modelsFailed : S.modelsUnavailable;
  const claudeEntries = grouped && !othersOpen ? pinnedEntries : [...pinnedEntries, ...otherEntries];
  const entries = [...claudeEntries, ...shownGroups.flatMap((shown) => (groupOpen(shown.group.key) ? shown.entries : []))];
  const renderRow = (entry: Entry, i: number) => (
    <ModelRow
      key={entry.kind === "model" ? entry.model.value : entry.kind === "group" ? `${entry.group}:${entry.value}` : "custom"}
      entry={entry}
      selected={entry.kind === "model" ? claudeCurrent !== null && modelMatches(entry.model, claudeCurrent) : entry.kind === "group" && entry.group === currentGroup && entry.value === current}
      active={i === index}
      shortcut={i < SHORTCUT_COUNT ? i + 1 : null}
      pinned={entry.kind === "model" && pinned.includes(entry.model.value)}
      onHover={() => setIndex(i)}
      onChoose={(e) => choose(entry, e.altKey)}
      onPin={modelPins !== null && entry.kind === "model" ? () => setModelPin("claude", entry.model.value, !pinned.includes(entry.model.value)) : undefined}
    />
  );

  const choose = (entry: Entry | undefined, asDefault = false) => {
    if (!entry) return;
    const value = entry.kind === "model" ? entry.model.value : entry.value;
    onClose();
    onChoose(value, asDefault, entry.kind === "group" ? entry.group : null);
  };
  const pickNth = useRef<(n: number, asDefault: boolean) => boolean>(() => false);
  pickNth.current = (n, asDefault) => {
    const entry = entries[n - 1];
    if (entry) choose(entry, asDefault);
    return true;
  };
  useEffect(
    () =>
      claimKeys((stroke) => {
        const match = /^(Alt\+)?Meta\+Digit([1-9])$/.exec(stroke);
        return match ? pickNth.current(Number(match[2]), match[1] !== undefined) : false;
      }),
    [],
  );
  return (
    <Popup anchor={anchor} placement="above" label={S.selectModel} className="popup-model" onClose={onClose}>
      <input
        className="popup-input"
        autoFocus
        aria-label={S.searchModels}
        placeholder={S.searchModels}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, entries.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(entries[index], e.altKey);
          } else if (e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
            e.preventDefault();
            e.stopPropagation();
            pickNth.current(Number(e.code.slice(5)), e.altKey);
          }
        }}
      />
      <div className="popup-list" role="listbox">
        <>
            {pinnedEntries.map((entry, i) => renderRow(entry, i))}
            {grouped && <GroupToggle label={S.otherModels} open={othersOpen} onToggle={() => setOthersOpen((v) => !v)} />}
            {(!grouped || othersOpen) && otherEntries.map((entry, i) => renderRow(entry, pinnedEntries.length + i))}
            {shownGroups.map(({ group, entries: groupEntries }) => {
              const start = entries.findIndex((entry) => entry.kind === "group" && entry.group === group.key);
              return (
                <Fragment key={group.key}>
                  <GroupToggle label={group.name} open={groupOpen(group.key)} onToggle={() => toggleGroup(group.key)} />
                  {groupOpen(group.key) && groupEntries.map((entry, i) => renderRow(entry, start + i))}
                </Fragment>
              );
            })}
            {models.length === 0 && (
              <div className="popup-empty" title={meta?.error ?? undefined}>
                {empty}
              </div>
            )}
        </>
      </div>
    </Popup>
  );
}

type Entry = { kind: "model"; model: ModelInfo } | { kind: "custom"; value: string } | { kind: "group"; group: string; value: string; name: string };

const SHORTCUT_COUNT = 9;

function ModelRow({ entry, selected, active, shortcut, pinned, onHover, onChoose, onPin }: { entry: Entry; selected: boolean; active: boolean; shortcut: number | null; pinned: boolean; onHover: () => void; onChoose: (event: { altKey: boolean }) => void; onPin: (() => void) | undefined }) {
  return (
    <div className="popup-row model-row" role="option" aria-selected={selected} data-active={active || undefined} onMouseEnter={onHover} onClick={onChoose}>
      <span className="popup-check">{selected && <Check size={12} />}</span>
      <span className="popup-row-title">{entry.kind === "model" ? entry.model.displayName : entry.kind === "group" ? entry.name : S.customModelOption(entry.value)}</span>
      {shortcut !== null && <kbd className="popup-row-key">⌘{shortcut}</kbd>}
      {entry.kind !== "custom" && (
        <button
          type="button"
          className="popup-row-action"
          disabled={!onPin}
          data-on={pinned || undefined}
          aria-label={pinned ? S.unpinModel : S.pinModel}
          title={pinned ? S.unpinModel : S.pinModel}
          onClick={(e) => {
            e.stopPropagation();
            onPin?.();
          }}
        >
          <Pin size={12} />
        </button>
      )}
    </div>
  );
}

function GroupToggle({ label, open, aria, onToggle }: { label: string; open: boolean; aria?: string; onToggle: () => void }) {
  return (
    <button type="button" className="popup-row popup-group" aria-expanded={open} aria-label={aria} onClick={onToggle}>
      <span className="popup-check">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
      <span className="popup-row-title">{label}</span>
    </button>
  );
}

export function cycleEffort() {
  const { model, effort } = currentModelAndEffort();
  const defaults = currentDefaults();
  const harness = activeHarness();
  const codexMeta = toolMetaOf(getState(), harness);
  const levels = harness !== "claude" ? codexLevels(codexMeta, model) : supportedLevels(model ?? defaults.model);
  if (levels.length === 0) return;
  const current = harness !== "claude" ? (effort ?? codexMeta?.defaultEffort ?? null) : (effort ?? defaults.effort ?? builtinEffort(levels));
  const next = levels[(levels.indexOf(current as EffortLevel) + 1) % levels.length];
  applyEffort(next);
  announce(S.effortCycled(effortName(next)));
}

function modelMatches(model: ModelInfo, current: string) {
  return model.value === current || (model.resolvedModel !== null && model.resolvedModel === current);
}
