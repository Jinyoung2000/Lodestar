import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type CodexMeta, type EffortLevel, type Harness, type Meta, type ModelInfo } from "../shared/protocol";
import { HARNESS_NAMES, otherHarness, switchBlock } from "../shared/harnessSwitch";
import { effortName } from "./Composer";
import { builtinEffort, supportedLevels } from "./effortLevels";
import { Check, ChevronDown, ChevronRight, Close, Codicon, Pin } from "./icons";
import { Popup, anchorInActivePane } from "./Popup";
import { rpc } from "./rpc";
import { activePane, flash, getState, rememberPick, setState, useStore, type State } from "./store";
import { S } from "./strings";
import { currentDefaults, currentDraftDefaults, useDefaults } from "./defaults";
import { announce } from "./announce";
import { claimKeys } from "./shortcuts";
import { activeHarness, codexLevels, codexModelInfos, codexDefaultModel, useCodexMeta, usePaneHarnessOfActive } from "./harness"; // CODEX

const PINNED_KEY = "agent-nav:pinned-models";

// 모델 선택(B3-04): 입력창의 모델 칩 위로 열리는 작은 팝업. 검색, 즐겨찾기한 모델, 나머지는 Other Models 아래.
// 모델 이름에는 항상 버전이 붙는다(displayName 전체). 목록에 없는 새 모델은 검색 칸에 이름을 입력해 그대로 쓸 수 있다(버그 2).
export function ModelPicker() {
  const paneId = useStore((s) => s.activePaneId);
  const defaults = useDefaults();
  // CODEX: Codex 칸이면 Codex 앱 서버의 모델 목록을 보이고, 고르지 않은 값은 config.toml 의 모델이다
  const harness = usePaneHarnessOfActive();
  const agentId = useStore((s) => activeAgentId(s));
  const unavailable = useStore((s) => (agentId ? kindBlock(s, agentId) : null));
  const codexMeta = useCodexMeta(agentId ? "codex" : harness);
  const picked = currentModelAndEffort().model;
  const current = harness === "codex" ? (picked ?? codexDefaultModel(codexMeta) ?? "") : (picked ?? defaults.model ?? "default");
  return (
    <ModelMenu
      anchor={anchorInActivePane("[data-model-chip]", paneId)}
      harness={harness}
      switchable={agentId !== null}
      unavailable={unavailable ? S.switchUnavailable[unavailable] : null}
      current={current}
      onClose={() => setState({ overlay: null })}
      onChoose={(value, asDefault, tool) => {
        if (agentId && tool !== harness) {
          switchTool(agentId, tool, value);
          return;
        }
        applyModel(value);
        // Settings 의 기본 모델은 Claude 의 것이라 Codex 칸에서는 바꾸지 않는다
        if (asDefault && harness === "claude") void rpc.call("settings.set", { defaultModel: value });
      }}
    />
  );
}

function activeAgentId(s: State): string | null {
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  return pane?.kind === "agent" ? pane.agentId : null;
}

function kindBlock(s: State, agentId: string): "notion" | "feedback" | "imported" | null {
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const block = switchBlock(agent, s.timelines[agentId] ?? []);
  return block === "notion" || block === "feedback" || block === "imported" ? block : null;
}

function switchTool(agentId: string, harness: Harness, model: string) {
  const s = getState();
  const agent = s.agents.find((a) => a.id === agentId);
  const levels = harness === "codex" ? codexLevels(s.codexMeta, model) : supportedLevels(model);
  const effort = agent?.effort && levels.includes(agent.effort) ? agent.effort : null;
  void rpc.call("agents.switchHarness", { agentId, harness, model, effort }).then(
    () => rememberPick(harness === "codex" ? { codexModel: model } : { model }),
    (error: Error) => flash(error.message, "warning"),
  );
}

function groupStatus(harness: Harness, claudeMeta: Meta | null, codexMeta: CodexMeta | null, unavailable: string | null): string | null {
  if (harness === "claude") return claudeMeta?.claudeMissing ? S.claudeNotInstalled : null;
  if (unavailable) return unavailable;
  if (!codexMeta) return S.codexModelsLoading;
  if (!codexMeta.installed) return S.codexNotInstalled;
  if (!codexMeta.loggedIn) return S.codexNotSignedIn;
  if (!codexMeta.models.length) return codexMeta.error ? S.codexLoadFailed(codexMeta.error) : S.modelsUnavailable;
  return null;
}

type ModelMenuProps = {
  anchor: HTMLElement | null;
  current: string;
  onChoose: (value: string, asDefault: boolean, tool: Harness) => void;
  onClose: () => void;
  harness?: Harness;
  switchable?: boolean;
  unavailable?: string | null;
};

// 모델 목록 팝업 본체. 입력창(메인 대화)과 빠른 질문 창이 같이 쓰고, 고른 모델을 어디에 저장할지는 onChoose 가 정한다.
// 닫기는 onClose, 고른 뒤에도 onClose 가 불린다. asDefault 는 ⌥ 를 누른 채 골랐을 때다.
export function ModelMenu({ anchor, current, onChoose, onClose, harness = "claude", switchable = false, unavailable = null }: ModelMenuProps) {
  const claudeMeta = useStore((s) => s.meta);
  const codexMeta = useStore((s) => s.codexMeta);
  const meta = harness === "codex" ? null : claudeMeta;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [othersOpen, setOthersOpen] = useState(false);
  const [closedGroups, setClosedGroups] = useState<Harness[]>([]);
  const [pinned, setPinned] = useState(readPinned);
  const models = harness === "codex" ? codexModelInfos(codexMeta) : (meta?.models ?? []);
  const other = otherHarness(harness);
  const otherStatus = switchable ? groupStatus(other, claudeMeta, codexMeta, unavailable) : null;
  const switchModels = useMemo(() => (switchable && !otherStatus ? (other === "codex" ? codexModelInfos(codexMeta) : (claudeMeta?.models ?? [])) : []), [switchable, otherStatus, other, codexMeta, claudeMeta]);
  const q = query.trim().toLowerCase();

  const currentValue = models.find((m) => modelMatches(m, current))?.value;
  const top = currentValue && !pinned.includes(currentValue) ? [...pinned, currentValue] : pinned;
  const grouped = top.length > 0 && !q && !switchable;
  const { pinnedEntries, otherEntries, switchEntries } = useMemo(() => {
    const matching = (list: ModelInfo[]) => (q ? list.filter((m) => `${m.displayName} ${m.value} ${m.resolvedModel ?? ""}`.toLowerCase().includes(q)) : list);
    const matches = matching(models);
    const toEntry = (tool: Harness) => (model: ModelInfo): Entry => ({ kind: "model", model, tool });
    const ordered = switchable && !q ? [...matches.filter((m) => top.includes(m.value)), ...matches.filter((m) => !top.includes(m.value))] : matches;
    const pinnedEntries = grouped ? matches.filter((m) => top.includes(m.value)).map(toEntry(harness)) : [];
    const otherEntries = (grouped ? matches.filter((m) => !top.includes(m.value)) : ordered).map(toEntry(harness));
    // 목록에 없는 이름을 입력하면 그대로 쓰는 항목이 맨 아래에 붙는다.
    const known = [...models, ...switchModels].some((m) => [m.value, m.displayName, m.resolvedModel].some((v) => v?.toLowerCase() === q));
    if (q && !known && /^[\w.[\]:/-]+$/.test(query.trim())) otherEntries.push({ kind: "custom", value: query.trim(), tool: harness });
    return { pinnedEntries, otherEntries, switchEntries: matching(switchModels).map(toEntry(other)) };
  }, [models, switchModels, q, query, top, grouped, switchable, harness, other]);
  const ownGroup = { tool: harness, entries: otherEntries, empty: models.length === 0 ? (harness === "codex" ? (codexMeta?.error ? S.codexLoadFailed(codexMeta.error) : codexMeta ? S.modelsUnavailable : S.codexModelsLoading) : meta?.error ? S.modelsFailed : S.modelsUnavailable) : null };
  const switchGroup = { tool: other, entries: switchEntries, empty: otherStatus };
  const groups = switchable ? (harness === "claude" ? [ownGroup, switchGroup] : [switchGroup, ownGroup]) : [];
  // 키보드로 오가는 순서. 접힌 Other Models 는 건너뛴다.
  const entries = switchable ? groups.flatMap((g) => (closedGroups.includes(g.tool) ? [] : g.entries)) : grouped && !othersOpen ? pinnedEntries : [...pinnedEntries, ...otherEntries];
  const renderRow = (entry: Entry, i: number) => (
    <ModelRow
      key={entry.kind === "model" ? `${entry.tool}:${entry.model.value}` : "custom"}
      entry={entry}
      selected={entry.kind === "model" && entry.tool === harness && modelMatches(entry.model, current)}
      active={i === index}
      shortcut={i < SHORTCUT_COUNT ? i + 1 : null}
      pinned={entry.kind === "model" && pinned.includes(entry.model.value)}
      onHover={() => setIndex(i)}
      onChoose={(e) => choose(entry, e.altKey)}
      onPin={() => entry.kind === "model" && togglePin(entry.model.value)}
    />
  );

  const choose = (entry: Entry | undefined, asDefault = false) => {
    if (!entry) return;
    const value = entry.kind === "model" ? entry.model.value : entry.value;
    onClose();
    onChoose(value, asDefault, entry.tool);
  };
  // ⌘1~⌘9(⌥ 를 더하면 기본값으로도): 보이는 순서대로 n번째 모델을 바로 고른다. 단축키 표의 칸 전환(⌘숫자)보다 먼저 받는다.
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
  const togglePin = (value: string) => {
    const next = pinned.includes(value) ? pinned.filter((v) => v !== value) : [...pinned, value];
    setPinned(next);
    writePinned(next);
  };
  const toggleGroup = (tool: Harness) => {
    setClosedGroups((closed) => (closed.includes(tool) ? closed.filter((t) => t !== tool) : [...closed, tool]));
    setIndex(0);
  };

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
            // 브라우저로 붙은 창은 ⌘숫자가 여기로 온다(Electron 은 claimKeys 경로). 칸 전환으로 넘어가지 않게 멈춘다.
            e.preventDefault();
            e.stopPropagation();
            pickNth.current(Number(e.code.slice(5)), e.altKey);
          }
        }}
      />
      <div className="popup-list" role="listbox">
        {switchable ? (
          groups.map((group) => {
            const open = !closedGroups.includes(group.tool);
            return (
              <Fragment key={group.tool}>
                <GroupToggle label={HARNESS_NAMES[group.tool]} open={open} aria={S.modelGroupToggle(HARNESS_NAMES[group.tool], open)} onToggle={() => toggleGroup(group.tool)} />
                {open && group.entries.map((entry) => renderRow(entry, entries.indexOf(entry)))}
                {open && group.empty && <div className="popup-empty">{group.empty}</div>}
              </Fragment>
            );
          })
        ) : (
          <>
            {pinnedEntries.map((entry, i) => renderRow(entry, i))}
            {grouped && <GroupToggle label={S.otherModels} open={othersOpen} onToggle={() => setOthersOpen((v) => !v)} />}
            {(!grouped || othersOpen) && otherEntries.map((entry, i) => renderRow(entry, pinnedEntries.length + i))}
            {models.length === 0 && (
              <div className="popup-empty" title={harness === "claude" && meta?.error ? meta.error : undefined}>
                {ownGroup.empty}
              </div>
            )}
          </>
        )}
      </div>
    </Popup>
  );
}

type Entry = { kind: "model"; model: ModelInfo; tool: Harness } | { kind: "custom"; value: string; tool: Harness };

// ⌘1 부터 ⌘9 까지 보이는 순서대로 바로 고르는 단축키가 붙는 행 수
const SHORTCUT_COUNT = 9;

function ModelRow({ entry, selected, active, shortcut, pinned, onHover, onChoose, onPin }: { entry: Entry; selected: boolean; active: boolean; shortcut: number | null; pinned: boolean; onHover: () => void; onChoose: (event: { altKey: boolean }) => void; onPin: () => void }) {
  return (
    <div className="popup-row model-row" role="option" aria-selected={selected} data-active={active || undefined} onMouseEnter={onHover} onClick={onChoose}>
      <span className="popup-check">{selected && <Check size={12} />}</span>
      <span className="popup-row-title">{entry.kind === "model" ? entry.model.displayName : S.customModelOption(entry.value)}</span>
      {shortcut !== null && <kbd className="popup-row-key">⌘{shortcut}</kbd>}
      {entry.kind === "model" && (
        <button
          type="button"
          className="popup-row-action"
          data-on={pinned || undefined}
          aria-label={pinned ? S.unpinModel : S.pinModel}
          title={pinned ? S.unpinModel : S.pinModel}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
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

// 경고 머리글을 한 번 닫으면 이번 실행 동안은 다시 보이지 않는다
let warningDismissed = false;

// 생각 수준(B3-05): 팝업 제목 Thinking Level, 지원하는 단계만. 기본값에는 Default 표시.
export function EffortPicker() {
  const paneId = useStore((s) => s.activePaneId);
  const midSession = useStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.kind === "agent");
  const defaults = useDefaults();
  const [warned, setWarned] = useState(!warningDismissed);
  // CODEX: Codex 칸이면 Codex 모델이 지원하는 단계만 보이고, 고르지 않은 값은 config.toml 의 단계다
  const harness = usePaneHarnessOfActive();
  const codexMeta = useCodexMeta(harness);
  const { model, effort } = currentModelAndEffort();
  const levels = harness === "codex" ? codexLevels(codexMeta, model) : supportedLevels(model ?? defaults.model);
  const builtin = harness === "codex" ? (codexMeta?.defaultEffort ?? null) : builtinEffort(levels);
  const current = harness === "codex" ? (effort ?? builtin) : (effort ?? defaults.effort ?? builtin);
  const [index, setIndex] = useState(() => Math.max(0, current ? levels.indexOf(current) : 0));
  const choose = (value: EffortLevel | undefined, asDefault = false) => {
    if (value === undefined) return;
    setState({ overlay: null });
    applyEffort(value);
    if (asDefault && harness === "claude") void rpc.call("settings.set", { defaultEffort: value });
  };
  return (
    <Popup anchor={anchorInActivePane("[data-effort-chip]", paneId)} placement="above" label={S.thinkingLevel} className="popup-effort" onClose={() => setState({ overlay: null })}>
      <div
        className="popup-list"
        role="listbox"
        tabIndex={0}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, levels.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            choose(levels[index], e.altKey);
          }
        }}
      >
        {harness === "claude" && midSession && warned && (
          <div className="popup-warning" role="note">
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
        <div className="popup-title">{S.thinkingLevel}</div>
        {levels.length === 0 && <div className="popup-empty">{codexMeta?.error ? S.codexLoadFailed(codexMeta.error) : S.codexModelsLoading}</div>}
        {levels.map((level, i) => (
          <div key={level} className="popup-row" role="option" aria-selected={level === current} data-active={i === index || undefined} onMouseEnter={() => setIndex(i)} onClick={(e) => choose(level, e.altKey)}>
            <span className="popup-check">{level === current && <Check size={12} />}</span>
            <span className="popup-row-title">{effortName(level)}</span>
            {level === builtin && <span className="popup-row-detail">{S.effortDefaultBadge}</span>}
          </div>
        ))}
      </div>
    </Popup>
  );
}

// B5: ⇧⌘I. 팝업 없이 이 세션(또는 새 세션 화면)의 effort 를 지원하는 단계 안에서 한 단계씩 올리고, 끝에서 처음으로 돌아온다.
export function cycleEffort() {
  const { model, effort } = currentModelAndEffort();
  const defaults = currentDefaults();
  const harness = activeHarness();
  const codexMeta = getState().codexMeta;
  const levels = harness === "codex" ? codexLevels(codexMeta, model) : supportedLevels(model ?? defaults.model);
  if (levels.length === 0) return;
  const current = harness === "codex" ? (effort ?? codexMeta?.defaultEffort ?? null) : (effort ?? defaults.effort ?? builtinEffort(levels));
  const next = levels[(levels.indexOf(current as EffortLevel) + 1) % levels.length];
  applyEffort(next);
  // 입력창의 effort 칩이 바뀐 값을 보여 주므로 낭독만 한다
  announce(S.effortCycled(effortName(next)));
}

function modelMatches(model: ModelInfo, current: string) {
  return model.value === current || (model.resolvedModel !== null && model.resolvedModel === current);
}

function readPinned(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writePinned(values: string[]) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(values));
  } catch {
    // 즐겨찾기를 못 남겨도 이번 화면에서는 동작한다
  }
}

function applyModel(model: string | null) {
  // CODEX: Codex 쪽 마지막 선택은 Claude 의 것과 따로 기억한다(서로의 모델 id 가 새 세션에 넘어가지 않게)
  rememberPick(activeHarness() === "codex" ? { codexModel: model } : { model });
  const pane = activePane();
  if (pane.kind === "agent") void rpc.call("agents.setModel", { agentId: pane.agentId, model });
  else setState((s) => ({ draftModel: { ...s.draftModel, [pane.id]: model } }));
}

function applyEffort(effort: EffortLevel | null) {
  rememberPick(activeHarness() === "codex" ? { codexEffort: effort } : { effort });
  const pane = activePane();
  if (pane.kind === "agent") void rpc.call("agents.setEffort", { agentId: pane.agentId, effort });
  else setState((s) => ({ draftEffort: { ...s.draftEffort, [pane.id]: effort } }));
}

function currentModelAndEffort() {
  const s = getState();
  const pane = activePane();
  if (pane.kind === "agent") {
    const agent = s.agents.find((a) => a.id === pane.agentId);
    return { model: agent?.model ?? null, effort: agent?.effort ?? null };
  }
  // CODEX: 새 세션 화면이 Codex 면 Codex 쪽 마지막 선택에서 시작한다(없으면 null = Codex 가 config.toml 을 따른다)
  if (activeHarness() === "codex") {
    return {
      model: pane.id in s.draftModel ? s.draftModel[pane.id] : (s.lastPicked.codexModel ?? null),
      effort: pane.id in s.draftEffort ? s.draftEffort[pane.id] : (s.lastPicked.codexEffort ?? null),
    };
  }
  return {
    model: pane.id in s.draftModel ? s.draftModel[pane.id] : currentDraftDefaults().model,
    effort: pane.id in s.draftEffort ? s.draftEffort[pane.id] : currentDraftDefaults().effort,
  };
}
