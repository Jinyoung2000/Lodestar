import "./quickEntry.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Agent, ImageRef, ModelInfo, ResolvedDefaults, Settings, Workspace } from "../shared/protocol";
import { checkImage, clipboardImageFiles, imageProblemText } from "../shared/images";
import { ArrowUpCompact, Check, ChevronDown, Close, Codicon, CommentDiscussion, DotSpinner, FolderCompact } from "./icons";
import { makeThumb, readBase64 } from "./imageAttach";
import { canQuickSend, chosenModelRow, modelRows, parseDraft, planQuickSend, quickDefaults, quickKeyAction, quickModelName, sameTarget, targetLabel, targetRows, validModel, validTarget, type ModelRow, type QuickTarget, type TargetRow } from "./quickEntryModel";
import { rpc } from "./rpc";
import { S } from "./strings";

const DRAFT_KEY = "agent-nav:quick-entry-draft";
const MODEL_KEY = "agent-nav:quick-entry-model";

type QuickData = { workspaces: Workspace[]; agents: Agent[]; settings: Settings | null; resolved: ResolvedDefaults | null; models: ModelInfo[] };
type Menu = "target" | "model" | null;
type QuickImage = { mediaType: string; data: string; thumb: string; name: string };

export function QuickEntry() {
  const [data, setData] = useState<QuickData>({ workspaces: [], agents: [], settings: null, resolved: null, models: [] });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [initial] = useState(() => parseDraft(readDraft()));
  const [text, setText] = useState(initial.text);
  const [picked, setPicked] = useState<QuickTarget | null>(initial.target);
  const [images, setImages] = useState<QuickImage[]>([]);
  const [pickedModel, setPickedModel] = useState<string | null>(readModel);
  const [menu, setMenu] = useState<Menu>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef({ text, hasImages: false });
  draftRef.current = { text, hasImages: images.length > 0 };

  const target = useMemo(() => validTarget(picked, data.workspaces, data.agents), [picked, data.workspaces, data.agents]);
  const rows = useMemo(() => targetRows(data.workspaces, data.agents, target), [data.workspaces, data.agents, target]);
  const label = targetLabel(target, data.workspaces, data.agents);
  const defaults = quickDefaults(data.settings, data.resolved);
  const model = validModel(pickedModel, data.models);
  const modelShown = target.kind !== "session";
  const models = useMemo(() => modelRows(data.models, defaults.model), [data.models, defaults.model]);
  const chosenRow = chosenModelRow(models, model);
  const modelLabel = chosenRow?.label ?? quickModelName(model ?? defaults.model, data.models);
  const menuOpen = menu !== null;
  const menuLength = menu === "model" ? models.length : rows.length;
  const sendable = canQuickSend({ connected: connected !== false, busy, text, imageCount: images.length });

  const load = useCallback(async () => {
    try {
      const [workspaces, agents, settings, resolved, meta] = await Promise.all([rpc.call("workspaces.list", {}), rpc.call("agents.list", {}), rpc.call("settings.get", {}), rpc.call("defaults.get", {}).catch(() => null), rpc.call("meta.get", {}).catch(() => null)]);
      setData({ workspaces, agents, settings, resolved, models: meta?.models ?? [] });
    } catch {
    }
  }, []);

  useEffect(() => {
    void load();
    const offStatus = rpc.onStatus((up) => {
      setConnected(up);
      if (up) void load();
    });
    const offShow = window.agentNavNative?.onQuickEntryShow?.(() => {
      setMenu(null);
      setError(null);
      if (draftRef.current.text.trim() === "" && !draftRef.current.hasImages) setPicked(null);
      setShown((n) => n + 1);
      void load();
    });
    return () => {
      offStatus();
      offShow?.();
    };
  }, [load]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [shown]);

  useTheme(data.settings?.theme, data.settings?.themeStyle);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const report = () => void window.agentNavNative?.quickEntryResize?.(Math.ceil(card.getBoundingClientRect().height))?.catch(() => undefined);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    writeDraft({ text, target: picked });
  }, [text, picked]);

  useEffect(() => {
    if (menuOpen) document.getElementById(`quick-row-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, active]);

  const close = () => void window.agentNavNative?.quickEntryClose?.();

  const pick = (row: TargetRow) => {
    setPicked(row.target);
    setMenu(null);
    inputRef.current?.focus();
  };

  const pickModel = (row: ModelRow) => {
    const value = row.isDefault ? null : row.value;
    setPickedModel(value);
    writeModel(value);
    setMenu(null);
    inputRef.current?.focus();
  };

  const openMenu = (next: Exclude<Menu, null>) => {
    if (next === "model" && !modelShown) return;
    setActive(Math.max(0, next === "model" ? models.findIndex((row) => row === chosenRow) : rows.findIndex((row) => sameTarget(row.target, target))));
    setMenu(next);
  };

  const toggleMenu = (next: Exclude<Menu, null>) => (menu === next ? setMenu(null) : openMenu(next));

  const addImages = async (files: File[]) => {
    let count = images.length;
    for (const file of files) {
      const problem = checkImage(file.type, file.size, count);
      if (problem) {
        setError(imageProblemText(problem, file.name || "image"));
        if (problem === "count") break;
        continue;
      }
      try {
        const [data64, thumb] = await Promise.all([readBase64(file), makeThumb(file)]);
        setImages((list) => [...list, { mediaType: file.type, data: data64, thumb, name: file.name || "image" }]);
        count++;
      } catch {
        setError(imageProblemText("format", file.name || "image"));
      }
    }
  };

  const submit = async (stay: boolean) => {
    if (!sendable) return;
    const plan = planQuickSend({ target, text, imageCount: images.length, defaults: { ...defaults, model: model ?? defaults.model } });
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const refs: ImageRef[] = [];
      for (const image of images) {
        const { id } = await rpc.call("images.upload", { mediaType: image.mediaType, data: image.data, name: image.name });
        refs.push({ id, label: image.name, thumb: image.thumb });
      }
      const withImages = refs.length ? { images: refs } : {};
      let agentId: string;
      if (plan.method === "agents.create") agentId = (await rpc.call("agents.create", { ...plan.params, ...withImages })).id;
      else {
        await rpc.call("agents.send", { ...plan.params, ...withImages });
        agentId = plan.params.agentId;
      }
      writeDraft({ text: "", target: picked });
      setText("");
      setImages([]);
      await window.agentNavNative?.quickEntryFinish?.({ agentId, stay });
    } catch (e) {
      setError(S.quickEntryFailed((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inInput = e.target === inputRef.current;
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (menuOpen && !composing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, Math.min(menuLength - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
        return;
      }
      if (e.key === "Enter" && inInput && menu === "model" && models[active]) {
        e.preventDefault();
        pickModel(models[active]);
        return;
      }
      if (e.key === "Enter" && inInput && menu === "target" && rows[active]) {
        e.preventDefault();
        pick(rows[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    const action = quickKeyAction({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode });
    if (action === "close") {
      e.preventDefault();
      close();
    } else if (action === "menu") {
      e.preventDefault();
      openMenu("target");
    } else if (action === "model-menu") {
      e.preventDefault();
      openMenu("model");
    } else if ((action === "send-open" || action === "send-stay") && inInput) {
      e.preventDefault();
      void submit(action === "send-stay");
    }
  };

  return (
    <div className="quick-root" onKeyDown={onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={cardRef} className="quick-card" role="dialog" aria-label={S.quickEntryAria}>
        <div className="quick-bar">
          <span className="quick-mark" aria-hidden="true">
            <LodestarMark />
          </span>
          <textarea
            ref={inputRef}
            className="quick-input"
            rows={1}
            value={text}
            placeholder={S.quickEntryPlaceholder}
            aria-label={S.quickEntryInputAria}
            spellCheck={false}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = clipboardImageFiles(e.clipboardData);
              if (files.length === 0) return;
              e.preventDefault();
              void addImages(files);
            }}
          />
          <div className="quick-pills" data-with-model={modelShown || undefined}>
            <button type="button" className="pill" data-pill="target" aria-haspopup="listbox" aria-expanded={menu === "target"} aria-label={S.quickEntryTargetAria(label)} title={S.quickEntryTargetTip} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleMenu("target")}>
              <TargetIcon target={target} />
              <span>{label}</span>
              <ChevronDown size={12} />
            </button>
            {modelShown && (
              <button type="button" className="pill" data-pill="model" aria-haspopup="listbox" aria-expanded={menu === "model"} aria-label={S.quickEntryModelAria(modelLabel)} title={S.quickEntryModelTip} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleMenu("model")}>
                <span>{modelLabel}</span>
                <ChevronDown size={12} />
              </button>
            )}
          </div>
          <button type="button" className="quick-send" aria-label={S.quickEntrySendAria} title={S.quickEntrySendTip} disabled={!sendable} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit(false)}>
            {busy ? <DotSpinner size={14} /> : <ArrowUpCompact />}
          </button>
        </div>
        {images.length > 0 && (
          <div className="quick-attachments">
            {images.map((image, index) => (
              <div key={`${image.name}-${index}`} className="quick-chip">
                <img src={image.thumb} alt={image.name} />
                <button type="button" aria-label={S.quickEntryRemoveImage(image.name)} onMouseDown={(e) => e.preventDefault()} onClick={() => setImages((list) => list.filter((_, i) => i !== index))}>
                  <Close size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {connected === false && (
          <p className="quick-notice" role="status">
            {S.quickEntryDaemonDown}
          </p>
        )}
        {error && (
          <p className="quick-notice" data-kind="error" role="alert">
            {error}
          </p>
        )}
        {text.trim() !== "" && !menuOpen && (
          <div className="quick-hints">
            <span>
              <kbd>Enter</kbd> {S.quickEntryHintSend}
            </span>
            <span>
              <kbd>Cmd+Enter</kbd> {S.quickEntryHintStay}
            </span>
            <span>
              <kbd>Shift+Enter</kbd> {S.quickEntryHintNewline}
            </span>
          </div>
        )}
        {menu === "target" && <TargetList rows={rows} target={target} active={active} onActive={setActive} onPick={pick} />}
        {menu === "model" && <ModelList rows={models} chosen={chosenRow} active={active} onActive={setActive} onPick={pickModel} />}
      </div>
    </div>
  );
}

function TargetList({ rows, target, active, onActive, onPick }: { rows: TargetRow[]; target: QuickTarget; active: number; onActive: (index: number) => void; onPick: (row: TargetRow) => void }) {
  return (
    <div className="quick-list" role="listbox" aria-label={S.quickEntryTargetTip}>
      {rows.map((row, index) => (
        <div key={row.key}>
          {row.section === "new" && row.key === rows[0].key && <div className="quick-list-title">{S.quickEntryNewIn}</div>}
          {row.section === "session" && row.key === rows.find((r) => r.section === "session")?.key && <div className="quick-list-title">{S.quickEntryContinue}</div>}
          <TargetRowButton row={row} index={index} selected={sameTarget(row.target, target)} active={index === active} onActive={onActive} onPick={onPick} />
        </div>
      ))}
    </div>
  );
}

function TargetRowButton({ row, index, selected, active, onActive, onPick }: { row: TargetRow; index: number; selected: boolean; active: boolean; onActive: (index: number) => void; onPick: (row: TargetRow) => void }) {
  return (
    <button id={`quick-row-${index}`} type="button" role="option" aria-selected={selected} className="quick-row" data-active={active} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => onActive(index)} onClick={() => onPick(row)}>
      <span className="quick-row-icon">
        <TargetIcon target={row.target} />
      </span>
      <span className="quick-row-label">{row.label}</span>
      <span className="quick-row-hint">{row.hint}</span>
      {selected && <Check className="quick-row-check" size={14} />}
    </button>
  );
}

function ModelList({ rows, chosen, active, onActive, onPick }: { rows: ModelRow[]; chosen: ModelRow | undefined; active: number; onActive: (index: number) => void; onPick: (row: ModelRow) => void }) {
  return (
    <div className="quick-list" role="listbox" aria-label={S.quickEntryModelTip}>
      {rows.map((row, index) => (
        <button key={row.key} id={`quick-row-${index}`} type="button" role="option" aria-selected={row === chosen} className="quick-row" data-active={index === active} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => onActive(index)} onClick={() => onPick(row)}>
          <span className="quick-row-label">{row.label}</span>
          <span className="quick-row-hint">{row.hint}</span>
          {row.isDefault && <span className="quick-row-badge">{S.effortDefaultBadge}</span>}
          {row === chosen && <Check className="quick-row-check" size={14} />}
        </button>
      ))}
    </div>
  );
}

function TargetIcon({ target }: { target: QuickTarget }) {
  if (target.kind === "new") return <FolderCompact size={14} />;
  if (target.kind === "chat") return <CommentDiscussion size={14} />;
  return <Codicon name="comment" size={14} />;
}

function LodestarMark() {
  return (
    <svg viewBox="200 160 624 704" fill="currentColor" aria-hidden="true">
      <path d="M512 170 Q564 460 814 512 Q564 564 512 854 Q460 564 210 512 Q460 460 512 170 Z" />
    </svg>
  );
}

function useTheme(theme: Settings["theme"] | undefined, style: Settings["themeStyle"] | undefined) {
  useEffect(() => {
    if (style === "webstorm") document.documentElement.dataset.style = style;
    else delete document.documentElement.dataset.style;
  }, [style]);
  useEffect(() => {
    if (!theme) return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme === "black" ? "dark" : theme;
      if (theme === "black") document.documentElement.dataset.black = "true";
      else delete document.documentElement.dataset.black;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

function readDraft(): string | null {
  try {
    return localStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
}

function readModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

function writeModel(model: string | null) {
  try {
    if (model === null) localStorage.removeItem(MODEL_KEY);
    else localStorage.setItem(MODEL_KEY, model);
  } catch {
  }
}

function writeDraft(draft: { text: string; target: QuickTarget | null }) {
  try {
    if (draft.text === "" && draft.target === null) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
  }
}

export function initQuickView() {
  document.documentElement.classList.add("quick-entry");
  const theme = new URLSearchParams(location.search).get("theme");
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  rpc.connect();
}
