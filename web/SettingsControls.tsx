import { useEffect, useRef, useState } from "react";
import type { FormatLanguage, FormatterId, RuntimeInfo } from "../shared/protocol";
import { missingFirstFamily } from "./editorFont";
import { ImportSettings } from "./ImportSettings";
import { McpSection } from "./McpPanel";
import { LinearSettings } from "./LinearSettings";
import { MobileAccess } from "./MobileAccess";
import { Refresh } from "./icons";
import { QuickEntryShortcut } from "./QuickEntryShortcut";
import { rpc } from "./rpc";
import { decideNumberInput, NUMBER_SAVE_DELAY_MS, parseSettingNumber } from "./settingsSchema";
import type { SettingDef, SettingsCtx } from "./settingsItems";
import { refreshMeta, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { hint } from "./hint";

const DEBOUNCE_MS = 250;

export function SettingControl({ def, ctx }: { def: SettingDef; ctx: SettingsCtx }) {
  if (def.kind === "switch") return <SwitchControl def={def} ctx={ctx} />;
  if (def.kind === "enum") return <EnumControl def={def} ctx={ctx} />;
  if (def.kind === "number") return <NumberControl def={def} ctx={ctx} />;
  if (def.kind === "text") return <TextControl def={def} ctx={ctx} />;
  if (def.component === "formatLanguages") return <FormatLanguages ctx={ctx} />;
  if (def.component === "importSessions") return <ImportSettings scroll={false} />;
  if (def.component === "mcpServers") return <McpSection />;
  if (def.component === "quickEntryShortcut") return <QuickEntryShortcut ctx={ctx} />;
  if (def.component === "mobileAccess") return <MobileAccess />;
  if (def.component === "linear") return <LinearSettings />;
  return <DaemonStatus />;
}

function SwitchControl({ def, ctx }: { def: Extract<SettingDef, { kind: "switch" }>; ctx: SettingsCtx }) {
  return <Switch id={`setting-${def.id}`} aria-label={def.title} checked={def.value(ctx)} onCheckedChange={def.set} />;
}

function EnumControl({ def, ctx }: { def: Extract<SettingDef, { kind: "enum" }>; ctx: SettingsCtx }) {
  return (
    <Select value={def.value(ctx)} onValueChange={(value) => def.set(value, ctx)}>
      <SelectTrigger id={`setting-${def.id}`} boxed className="setting-select" aria-label={def.title}>
        <SelectValue placeholder={def.placeholder} />
      </SelectTrigger>
      <SelectContent>
        {def.options(ctx).map((option) => (
          <SelectItem key={option.value} value={option.value} title={option.title}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NumberControl({ def, ctx }: { def: Extract<SettingDef, { kind: "number" }>; ctx: SettingsCtx }) {
  const value = def.value(ctx);
  const [text, setText] = useState(String(value));
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    if (parseSettingNumber(text, def.min, def.max, def.step) !== value) setText(String(value));
    setProblem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => clearTimer, []);
  const commit = (next: string) => {
    clearTimer();
    const decision = decideNumberInput(next, def.min, def.max, def.step, value);
    if (decision.action === "save") def.set(decision.value);
    return decision;
  };
  const onChange = (next: string) => {
    setText(next);
    clearTimer();
    const decision = decideNumberInput(next, def.min, def.max, def.step, value);
    if (decision.action === "problem") {
      setProblem(decision.reason === "step" ? S.settingsNumberStep(def.step) : S.settingsNumberInvalid(def.min, def.max));
      return;
    }
    setProblem(null);
    if (decision.action === "save") timer.current = setTimeout(() => commit(next), NUMBER_SAVE_DELAY_MS);
  };
  const revert = () => {
    clearTimer();
    setText(String(value));
    setProblem(null);
  };
  const onBlur = () => {
    const decision = commit(text);
    if (decision.action === "problem") revert();
  };
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (problem === null) return;
    const leave = (event: Event) => {
      if (event.target === inputRef.current) return;
      revert();
    };
    const tab = (event: KeyboardEvent) => {
      if (event.key === "Tab" && event.target === inputRef.current) revert();
    };
    document.addEventListener("pointerdown", leave, true);
    document.addEventListener("keydown", tab, true);
    return () => {
      document.removeEventListener("pointerdown", leave, true);
      document.removeEventListener("keydown", tab, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem, value]);
  return (
    <>
      <input
        ref={inputRef}
        id={`setting-${def.id}`}
        className="input setting-number"
        type="number"
        aria-label={def.title}
        aria-invalid={problem !== null}
        step={def.step}
        min={def.min}
        max={def.max}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) commit(text);
        }}
        onBlur={onBlur}
      />
      {problem && (
        <span className="setting-problem" role="alert">
          {problem}
        </span>
      )}
    </>
  );
}

function TextControl({ def, ctx }: { def: Extract<SettingDef, { kind: "text" }>; ctx: SettingsCtx }) {
  const value = def.value(ctx);
  const [text, setText] = useState(value);
  const [missing, setMissing] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (!def.checkFont) return;
    const check = () => setMissing(text.trim() ? missingFirstFamily(text) : null);
    check();
    void document.fonts.ready.then(check);
  }, [text, def.checkFont]);
  const problem = def.validate?.(text) ?? null;
  const commit = (next: string) => {
    def.set(next);
    if (def.clearOnCommit) setText("");
  };
  const onChange = (next: string) => {
    setText(next);
    if (def.commit !== "change") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(next), DEBOUNCE_MS);
  };
  const onBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (def.commit !== "blur") return;
    if (problem) {
      hint(problem, event.currentTarget);
      setText(value);
      return;
    }
    if (text.trim() !== value.trim()) commit(text);
  };
  return (
    <>
      <input id={`setting-${def.id}`} className="input setting-text-input" spellCheck={false} aria-label={def.title} aria-invalid={problem !== null} placeholder={def.placeholder} value={text} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()} />
      {(problem || missing) && (
        <span className={problem ? "setting-problem" : "setting-warning"} role="status">
          {problem ?? S.fontNotInstalled(missing ?? "")}
        </span>
      )}
    </>
  );
}

const FOLLOW = "default";

function FormatLanguages({ ctx }: { ctx: SettingsCtx }) {
  if (!ctx.format) return <div className="setting-empty">{S.loading}</div>;
  return (
    <div className="setting-sublist">
      {ctx.format.languages.map((language) => (
        <LanguageRow key={language.id} language={language} chosen={ctx.settings.formatters ?? {}} />
      ))}
    </div>
  );
}

function LanguageRow({ language, chosen }: { language: FormatLanguage; chosen: Record<string, FormatterId> }) {
  const select = (value: string) => {
    const next = { ...chosen };
    if (value === FOLLOW) delete next[language.id];
    else next[language.id] = value as FormatterId;
    void rpc.call("settings.set", { formatters: next });
  };
  return (
    <div className="setting-subrow" data-testid={`format-language-${language.id}`}>
      <label htmlFor={`format-${language.id}`}>{language.name}</label>
      <span className={!language.chosen && isProblem(language) ? "warning-text xs" : "muted xs"}>{language.chosen ? S.formatSourceNote["agent-nav"] : sourceNote(language)}</span>
      <Select value={language.chosen ?? FOLLOW} onValueChange={select}>
        <SelectTrigger id={`format-${language.id}`} boxed className="setting-select" aria-label={language.name}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW}>{followLabel(language)}</SelectItem>
          {language.options.map((option) => (
            <SelectItem key={option.formatter} value={option.formatter}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function followLabel(language: FormatLanguage) {
  const { raw, label } = language.vscode;
  if (!raw) return S.formatterFollowNone;
  return S.formatterFollowVscode(label ?? raw);
}

function sourceNote(language: FormatLanguage) {
  const { scope, raw, label, supported } = language.vscode;
  if (!scope) return S.formatSourceNote.builtin;
  if (raw && !label) return S.formatterCannotRun;
  if (raw && !supported) return S.formatterCannotFormat;
  return `${S.formatSourceNote.vscode} (${S.formatterScope[scope]})`;
}

function isProblem(language: FormatLanguage) {
  const { raw, label, supported } = language.vscode;
  return !!raw && (!label || !supported);
}

function DaemonStatus() {
  const meta = useStore((s) => s.meta);
  const connected = useStore((s) => s.connected);
  const refreshing = useStore((s) => s.metaRefreshing);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  useEffect(() => {
    void rpc.call("runtime.info", {}).then(setRuntime).catch(() => setRuntime(null));
  }, [connected]);
  return (
    <div className="setting-daemon">
      <div className="setting-daemon-line">
        <span className="dot" data-state={connected ? "ok" : "off"} />
        <span>{connected ? S.daemonConnected : S.daemonConnecting}</span>
        <span className="spacer" />
        <span className="muted">{meta?.claudeVersion ? `Claude Code ${meta.claudeVersion}` : meta?.error ? S.claudeDidNotStart : "Claude Code"}</span>
        <Button size="icon" aria-label={S.refresh} title={S.refresh} disabled={refreshing} onClick={() => void refreshMeta()}>
          <Refresh />
        </Button>
      </div>
      {meta?.account && (meta.account.email || meta.account.subscriptionType) && <div className="setting-daemon-line muted">{[meta.account.email, meta.account.subscriptionType].filter(Boolean).join(", ")}</div>}
      {runtime && <div className="setting-daemon-line muted">{runtime.kind === "repo" ? S.runningFromRepo(tildePath(runtime.root)) : S.runningFromBundle(runtime.note)}</div>}
      {meta?.error && <div className="setting-daemon-line error-text">{meta.error}</div>}
    </div>
  );
}

function tildePath(path: string) {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}
