import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CLAUDE_EFFORT_LEVELS, HARNESS_VALUES, type EffortLevel, type Harness } from "../shared/protocol";
import { codexModelEffort } from "../shared/modelChoices";
import { switchBlock } from "../shared/harnessSwitch";
import { effortName } from "./Composer";
import { useDefaults } from "./defaults";
import { codexDefaultModel, toolMetaOf, toolStatus, usePaneHarnessOfActive, usePaneProviderOfActive, useToolMeta } from "./harness";
import { Check, Close, Codicon, CustomProviderIcon, ProviderIcon } from "./icons";
import {
  carryLevel,
  choiceRows,
  claudeModels,
  isModel,
  landingKey,
  pickerRows,
  pinKey,
  PROVIDER_TABS,
  providerIdOf,
  providerModels,
  rowKey,
  rowProviderId,
  rowSource,
  rowTool,
  rowValue,
  sourceOf,
  stepTab,
  toolModels,
  toolOfSource,
  type SourceKey,
  type ChoiceRow,
  type PickerRow,
  type Provider,
  type ProviderTab,
} from "./modelChoices";
import { applyEffort, applyModel, currentModelAndEffort, lastPickedModel, setModelPin, startDraftOn, switchTool } from "./modelPick";
import { Popup, anchorInActivePane } from "./Popup";
import { rpc } from "./rpc";
import { claimKeys } from "./shortcuts";
import { setState, useStore, type State } from "./store";
import { S } from "./strings";

type Area = "list" | "levels";

const SHORTCUT_COUNT = 9;
let warningDismissed = false;

export function ModelPicker() {
  return <ModelPopover area="list" />;
}

export function EffortPicker() {
  return <ModelPopover area="levels" />;
}

function blockOf(s: State, agentId: string | null): "notion" | "feedback" | null {
  const agent = agentId ? s.agents.find((a) => a.id === agentId) : undefined;
  if (!agent) return null;
  const block = switchBlock(agent, s.timelines[agent.id] ?? []);
  return block === "notion" || block === "feedback" ? block : null;
}

function levelsOf(row: ChoiceRow | undefined): EffortLevel[] {
  if (!row) return [];
  if (row.kind === "model") return row.model.levels;
  return row.tool === "claude" ? [...CLAUDE_EFFORT_LEVELS] : [];
}

function defaultLevelOf(row: ChoiceRow | undefined): EffortLevel | null {
  if (row?.kind === "model") return row.model.defaultLevel;
  return row?.tool === "claude" ? "high" : null;
}

function ModelPopover({ area: firstArea }: { area: Area }) {
  const paneId = useStore((s) => s.activePaneId);
  const pane = useStore((s) => s.panes.find((p) => p.id === s.activePaneId));
  const agentId = pane?.kind === "agent" ? pane.agentId : null;
  const handoff = pane?.kind === "draft" && !!pane.handoff;
  const harness = usePaneHarnessOfActive();
  const providerId = usePaneProviderOfActive();
  const source = sourceOf(harness, providerId);
  const customProviders = useStore((s) => s.customProviders) ?? [];
  const blocked = useStore((s) => blockOf(s, agentId));
  const defaults = useDefaults();
  useToolMeta("codex");
  useToolMeta("antigravity");
  useToolMeta("cursor");
  const claudeMeta = useStore((s) => s.meta);
  const codexMeta = useStore((s) => s.codexMeta);
  const defaultCodexModel = useStore((s) => s.settings?.defaultCodexModel);
  const defaultCodexEffort = useStore((s) => s.settings?.defaultCodexEffort);
  const antigravityMeta = useStore((s) => s.antigravityMeta);
  const cursorMeta = useStore((s) => s.cursorMeta);
  const modelPins = useStore((s) => s.modelPins);
  const pinned = modelPins ?? [];
  const [tab, setTab] = useState<ProviderTab>(() => (firstArea === "list" && pinned.length > 0 ? "pinned" : source));
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [area, setArea] = useState<Area>(firstArea);
  const [levelPick, setLevelPick] = useState<{ row: string; level: EffortLevel } | null>(null);
  const [warned, setWarned] = useState(!warningDismissed);
  const inputRef = useRef<HTMLInputElement>(null);
  const levelsRef = useRef<HTMLDivElement>(null);
  const levelsFocused = useRef(false);

  const metas = { codexMeta, antigravityMeta, cursorMeta };
  const statusOf = (next: SourceKey): string | null => {
    if (next !== source && handoff) return S.handoffClaudeOnly;
    if (next !== source && blocked) return S.switchUnavailable[blocked];
    const custom = providerIdOf(next);
    if (custom) return customProviders.find((p) => p.id === custom)?.hasKey ? null : S.providerNeedsKey;
    const tool = toolOfSource(next);
    if (tool === "claude") return claudeMeta?.claudeMissing ? S.claudeNotInstalled : claudeMeta && claudeMeta.models.length === 0 ? (claudeMeta.error ? S.modelsFailed : S.modelsUnavailable) : null;
    return toolStatus(tool, toolMetaOf(metas, tool));
  };
  const providers: Provider[] = [
    ...HARNESS_VALUES.map((tool) => ({
      tool,
      models: tool === "claude" ? claudeModels(claudeMeta?.models ?? [], defaults.model) : toolModels(tool, toolMetaOf(metas, tool)),
      status: statusOf(tool),
    })),
    ...customProviders.map((p) => ({ tool: "claude" as const, providerId: p.id, name: p.name, models: providerModels(p), status: statusOf(`p:${p.id}`) })),
  ];
  const tabs: ProviderTab[] = [...PROVIDER_TABS, ...customProviders.map((p) => `p:${p.id}` as const)];
  const firstCustomTab = customProviders.length ? `p:${customProviders[0].id}` : null;
  const nameOf = (value: SourceKey) => customProviders.find((p) => `p:${p.id}` === value)?.name ?? S.harnessNames[toolOfSource(value)];
  const stored = currentModelAndEffort();
  const ownMeta = toolMetaOf(metas, harness);
  const ownProvider = customProviders.find((p) => p.id === providerId);
  const currentModel = ownProvider ? (stored.model ?? ownProvider.defaultModel) : harness === "claude" ? (stored.model ?? defaults.model ?? "default") : (stored.model ?? codexDefaultModel(ownMeta));
  const currentProvider = providers.find((p) => sourceOf(p.tool, p.providerId) === source);
  const currentInfo = currentProvider?.models.find((m) => isModel(m, currentModel));
  const currentEffort = ownProvider ? null : harness === "claude" ? (stored.effort ?? defaults.effort ?? currentInfo?.defaultLevel ?? null) : (stored.effort ?? (harness === "codex" ? codexModelEffort(ownMeta, stored.model) : currentInfo?.defaultLevel ?? ownMeta?.defaultEffort ?? null));

  const rows = pickerRows(providers, tab, query, pinned, tab === "pinned" || providerIdOf(tab) ? harness : toolOfSource(tab));
  const choices = choiceRows(rows);
  const landingFor = (next: ProviderTab, list: ChoiceRow[]) => {
    if (next === "pinned" || next === source || query.trim()) return landingKey(list, [[source, currentModel]]);
    const custom = providerIdOf(next);
    if (custom) return landingKey(list, [[next, lastPickedModel("claude", custom)], [next, customProviders.find((p) => p.id === custom)?.defaultModel ?? null]]);
    const tool = toolOfSource(next);
    const meta = tool === "claude" ? null : toolMetaOf(metas, tool);
    const preferredModel = (tool === "codex" ? defaultCodexModel : null) ?? lastPickedModel(tool);
    return landingKey(list, [[next, preferredModel], [next, tool === "claude" ? (defaults.model ?? "default") : codexDefaultModel(meta)]]);
  };
  const activeKey = highlight && choices.some((r) => rowKey(r) === highlight) ? highlight : landingFor(tab, choices);
  const activeRow = choices.find((r) => rowKey(r) === activeKey);
  const activeSource = activeRow ? rowSource(activeRow) : source;
  const isCurrent = (row: ChoiceRow) => rowSource(row) === source && row.kind === "model" && isModel(row.model, currentModel);
  const levels = levelsOf(activeRow);
  const levelDefault = defaultLevelOf(activeRow);
  const levelFor = (row: ChoiceRow) => {
    if (isCurrent(row)) return currentEffort;
    const preferred = !agentId && harness !== "codex" && rowTool(row) === "codex" ? defaultCodexEffort ?? currentEffort : currentEffort;
    return carryLevel(preferred, levelsOf(row), defaultLevelOf(row));
  };
  const chosenLevel = activeRow ? levelFor(activeRow) : null;
  const levelHighlight = levelPick && levelPick.row === activeKey ? levelPick.level : (chosenLevel ?? levels[0] ?? null);
  const showWarning = agentId !== null && harness === "claude" && !providerId && warned;

  const close = () => setState({ overlay: null });

  const choose = (row: ChoiceRow | undefined, level: EffortLevel | null, asDefault: { model: boolean; effort: boolean }) => {
    if (!row) return;
    const tool = rowTool(row);
    const value = rowValue(row);
    const rowProvider = rowProviderId(row);
    close();
    if (rowSource(row) !== source && agentId) return switchTool(agentId, tool, value, level, rowProvider);
    if (rowSource(row) !== source) return startDraftOn(tool, value, level, rowProvider);
    if (!isCurrent(row)) applyModel(value, tool, rowProvider);
    if (!rowProvider && level !== currentEffort) applyEffort(level, tool);
    if (tool !== "claude" || rowProvider) return;
    if (asDefault.model) void rpc.call("settings.set", { defaultModel: value });
    if (asDefault.effort && level) void rpc.call("settings.set", { defaultEffort: level });
  };

  const moveTab = (next: ProviderTab) => {
    setTab(next);
    setQuery("");
    setHighlight(null);
  };
  const moveHighlight = (step: 1 | -1) => {
    if (!choices.length) return;
    const index = choices.findIndex((r) => rowKey(r) === activeKey);
    setHighlight(rowKey(choices[Math.max(0, Math.min(choices.length - 1, index + step))]));
  };
  const moveLevel = (step: 1 | -1) => {
    if (!levels.length || !activeKey) return;
    const index = levelHighlight ? levels.indexOf(levelHighlight) : -1;
    setLevelPick({ row: activeKey, level: levels[Math.max(0, Math.min(levels.length - 1, index + step))] });
  };
  const focusArea = (next: Area) => {
    if (next === "levels" && levels.length === 0) return;
    setArea(next);
    if (next === "levels") levelsRef.current?.focus();
    else inputRef.current?.focus();
  };
  const pickNth = (n: number, alt: boolean) => {
    const row = choices[n - 1];
    if (row) choose(row, levelFor(row), { model: alt, effort: false });
    return true;
  };
  const strokes = useRef<(stroke: string) => boolean>(() => false);
  strokes.current = (stroke) => {
    const digit = /^(Alt\+)?Meta\+Digit([1-9])$/.exec(stroke);
    if (digit) return pickNth(Number(digit[2]), digit[1] !== undefined);
    if (stroke === "Ctrl+Tab" || stroke === "Ctrl+Shift+Tab") {
      moveTab(stepTab(tab, stroke === "Ctrl+Tab" ? 1 : -1, tabs));
      return true;
    }
    return false;
  };
  useEffect(() => claimKeys((stroke) => strokes.current(stroke)), []);

  const commonKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return true;
    if (e.key === "Tab" && e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      moveTab(stepTab(tab, e.shiftKey ? -1 : 1, tabs));
      if (area === "levels") focusArea("list");
      return true;
    }
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      pickNth(Number(e.code.slice(5)), e.altKey);
      return true;
    }
    return false;
  };
  const onListKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (commonKeys(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(activeRow, chosenLevel, { model: e.altKey, effort: false });
    } else if (e.key === "Tab") {
      e.preventDefault();
      focusArea("levels");
    }
  };
  const onLevelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (commonKeys(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveLevel(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(activeRow, levelHighlight, { model: false, effort: e.altKey });
    } else if (e.key === "Tab") {
      e.preventDefault();
      focusArea("list");
    }
  };

  const listLabel = query.trim() ? S.matchingModelsAria : tab === "pinned" ? S.pinnedModels : S.providerModelsAria(nameOf(tab));
  const emptyText = query.trim() ? S.noMatchingModels : tab === "pinned" ? S.pinnedEmpty : null;
  const showLevels = activeRow !== undefined;

  return (
    <Popup anchor={anchorInActivePane("[data-model-chip]", paneId)} placement="above" label={S.selectModel} className="model-popover" onClose={close}>
      <div className="model-popover-grid" data-levels={showLevels || undefined}>
        <div className="model-popover-rail" role="tablist" aria-orientation="vertical" aria-label={S.providersAria}>
          {tabs.map((value) => (
            <Fragment key={value}>
              {value === firstCustomTab && <span className="model-popover-rail-separator" aria-hidden="true" />}
              <button
                type="button"
                role="tab"
                className="model-popover-tab"
                aria-selected={value === tab && !query.trim()}
                aria-label={value === "pinned" ? S.pinnedModels : providers.find((p) => sourceOf(p.tool, p.providerId) === value)?.status ? S.providerUnavailableAria(nameOf(value)) : nameOf(value)}
                title={value === "pinned" ? S.pinnedModels : nameOf(value)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => moveTab(value)}
              >
                {value === "pinned" ? <Codicon name="star-full" /> : providerIdOf(value) ? <CustomProviderIcon name={nameOf(value)} /> : <ProviderIcon harness={toolOfSource(value)} />}
              </button>
              {value === "pinned" && <span className="model-popover-rail-separator" aria-hidden="true" />}
            </Fragment>
          ))}
        </div>
        <div className="model-popover-models">
          <input
            ref={inputRef}
            className="popup-input"
            autoFocus={firstArea === "list"}
            aria-label={S.searchModels}
            placeholder={S.searchModels}
            value={query}
            onFocus={() => setArea("list")}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(null);
            }}
            onKeyDown={onListKey}
          />
          <div className="model-popover-list" role="listbox" aria-label={listLabel}>
            {rows.map((row) => (
              <PopoverRow
                key={row.kind === "header" ? `h:${sourceOf(row.tool, row.providerId)}` : row.kind === "status" ? `s:${sourceOf(row.tool, row.providerId)}` : rowKey(row)}
                row={row}
                choices={choices}
                activeKey={activeKey}
                isCurrent={isCurrent}
                continuesIn={agentId !== null && activeSource !== source ? S.continuesIn(nameOf(activeSource)) : null}
                pinned={pinned}
                onHover={(key) => setHighlight(key)}
                onChoose={(choice, alt) => choose(choice, levelFor(choice), { model: alt, effort: false })}
                onPin={modelPins === null ? undefined : setModelPin}
              />
            ))}
            {rows.length === 0 && emptyText && <div className="model-popover-status" role="status">{emptyText}</div>}
          </div>
        </div>
        {showLevels && (
          <div className="model-popover-levels">
            <div className="model-popover-levels-head">
              <span className="model-popover-heading">{S.thinkingLevel}</span>
              <span className="model-popover-levels-model">{activeRow.kind === "model" ? activeRow.model.displayName : activeRow.value}</span>
            </div>
            <div
              ref={(el) => {
                levelsRef.current = el;
                if (el && firstArea === "levels" && !levelsFocused.current) {
                  levelsFocused.current = true;
                  el.focus();
                }
              }}
              className="model-popover-level-list"
              role="listbox"
              aria-label={S.thinkingLevel}
              tabIndex={-1}
              data-focused={area === "levels" || undefined}
              onFocus={() => setArea("levels")}
              onKeyDown={onLevelKey}
            >
              {levels.map((level) => (
                <div
                  key={level}
                  className="popup-row"
                  role="option"
                  aria-selected={level === chosenLevel}
                  data-active={(area === "levels" && level === levelHighlight) || undefined}
                  onMouseEnter={() => activeKey && setLevelPick({ row: activeKey, level })}
                  onClick={(e) => choose(activeRow, level, { model: false, effort: e.altKey })}
                >
                  <span className="popup-check">{level === chosenLevel && <Check size={12} />}</span>
                  <span className="popup-row-title">{effortName(level)}</span>
                  {level === levelDefault && <span className="popup-row-detail">{S.effortDefaultBadge}</span>}
                </div>
              ))}
              {levels.length === 0 && <div className="model-popover-status">{S.noThinkingLevels}</div>}
            </div>
          </div>
        )}
        {showWarning && (
          <div className="model-popover-note" role="note">
            <Codicon name="info" size={14} />
            <span>{S.effortMidSessionWarning}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={S.close}
              onClick={() => {
                warningDismissed = true;
                setWarned(false);
              }}
            >
              <Close size={14} />
            </button>
          </div>
        )}
      </div>
    </Popup>
  );
}

type PopoverRowProps = {
  row: PickerRow;
  choices: ChoiceRow[];
  activeKey: string | null;
  isCurrent: (row: ChoiceRow) => boolean;
  continuesIn: string | null;
  pinned: string[];
  onHover: (key: string) => void;
  onChoose: (row: ChoiceRow, alt: boolean) => void;
  onPin: ((harness: Harness, model: string, pinned: boolean, providerId?: string | null) => void) | undefined;
};

function PopoverRow({ row, choices, activeKey, isCurrent, continuesIn, pinned, onHover, onChoose, onPin }: PopoverRowProps) {
  if (row.kind === "header") return <div className="model-popover-heading model-popover-group" role="presentation">{row.providerId ? row.name : S.harnessNames[row.tool]}</div>;
  if (row.kind === "status") return <div className="model-popover-status" role="status">{row.text}</div>;
  const key = rowKey(row);
  const index = choices.findIndex((r) => rowKey(r) === key);
  const active = key === activeKey;
  const current = isCurrent(row);
  const pin = row.kind === "model" ? pinKey(row.model.tool, row.model.value, row.model.providerId) : null;
  const isPinned = pin !== null && pinned.includes(pin);
  const detail = active && continuesIn ? continuesIn : row.kind === "model" && row.model.isDefault ? S.effortDefaultBadge : null;
  return (
    <div
      ref={active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
      className="popup-row model-row"
      role="option"
      aria-selected={current}
      data-active={active || undefined}
      onMouseEnter={() => onHover(key)}
      onClick={(e) => onChoose(row, e.altKey)}
    >
      <span className="popup-check">{current && <Check size={12} />}</span>
      <span className="popup-row-title model-popover-name">{row.kind === "model" ? row.model.displayName : S.customModelOption(row.value)}</span>
      {detail && <span className="model-popover-detail">{detail}</span>}
      {index < SHORTCUT_COUNT && <kbd className="popup-row-key">⌘{index + 1}</kbd>}
      {pin && row.kind === "model" && (
        <button
          type="button"
          className="popup-row-action"
          disabled={!onPin}
          data-on={isPinned || undefined}
          aria-label={isPinned ? S.unpinModel : S.pinModel}
          title={isPinned ? S.unpinModel : S.pinModel}
          onClick={(e) => {
            e.stopPropagation();
            onPin?.(row.model.tool, row.model.value, !isPinned, row.model.providerId);
          }}
        >
          <Codicon name={isPinned ? "star-full" : "star-empty"} size={12} />
        </button>
      )}
    </div>
  );
}
