import { useEffect, useRef, useState } from "react";
import type { FormatLanguage, FormatterId, RuntimeInfo } from "../shared/protocol";
import { missingFirstFamily } from "./editorFont";
import { ImportSettings } from "./ImportSettings";
import { McpSection } from "./McpPanel";
import { LinearSettings } from "./LinearSettings"; // LINEAR
import { MobileAccess } from "./MobileAccess"; // MOBILE
import { Refresh } from "./icons";
import { QuickEntryShortcut } from "./QuickEntryShortcut"; // QUICKENTRY
import { rpc } from "./rpc";
import { decideNumberInput, NUMBER_SAVE_DELAY_MS, parseSettingNumber } from "./settingsSchema";
import type { SettingDef, SettingsCtx } from "./settingsItems";
import { refreshMeta, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { hint } from "./hint";

// Settings 행의 오른쪽(또는 아래) 컨트롤. 행 정의(settingsItems.ts)의 kind 에 따라 하나를 고른다.
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

// 숫자는 범위 안이고 단위(step)에 맞을 때만 저장한다. 키마다 저장하지 않고 입력을 멈추고 잠깐 뒤, 또는 Enter 와 입력칸을 떠날 때 저장한다.
// 유효하지 않은 값이면 이유를 아래에 보이고 저장하지 않으며, 입력칸을 떠나면 저장된 값으로 되돌린다.
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
    // 저장된 값이 바뀔 때(Reset 포함)만 입력칸을 맞춘다. 타이핑 중인 text 로는 다시 돌리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => clearTimer, []);
  // 지금 입력을 판정하고 유효하면 저장한다(Enter, blur 가 부른다). 저장 뒤의 text 는 useEffect([value]) 가 맞춘다.
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
  // 창이 OS 포커스를 못 받은 상태(다른 앱을 쓰는 중, 포커스 없는 시험 창)에서는 입력칸을 떠나도 blur 가 오지 않는다.
  // 범위 밖 값이 남아 있는 동안은 바깥을 누르거나 Tab 을 눌러 떠나는 것을 직접 보고 같은 되돌림을 한다.
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
    // revert 는 렌더마다 새로 만들어지지만 value 와 timer 만 쓴다. problem 이 바뀔 때만 다시 건다.
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

// change 는 입력하는 동안 잠깐 모았다가 저장하고(글꼴 이름), blur 는 입력칸을 떠날 때 저장한다(ID, 모델 이름).
function TextControl({ def, ctx }: { def: Extract<SettingDef, { kind: "text" }>; ctx: SettingsCtx }) {
  const value = def.value(ctx);
  const [text, setText] = useState(value);
  const [missing, setMissing] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // 글꼴 목록의 첫 이름이 설치돼 있는지는 입력하는 즉시(저장 전에) 보여준다. 글꼴 로드가 늦을 수 있어 로드가 끝나면 다시 본다.
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

// 못 쓰는 포맷터가 잡혀 있으면 출처 대신 그 사정을 보인다
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

// 데몬 연결, Claude Code 버전, 계정, 어디서 실행 중인지. 예전 Settings 맨 위 줄들이다.
function DaemonStatus() {
  const meta = useStore((s) => s.meta);
  const connected = useStore((s) => s.connected);
  const refreshing = useStore((s) => s.metaRefreshing);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  // 재시작 뒤 다시 열 때 값이 바뀌어 있을 수 있어 연결이 바뀔 때마다 읽는다.
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

// 홈 폴더는 ~ 로 줄여 보인다. 홈 경로를 모르면 그대로 둔다.
function tildePath(path: string) {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}
