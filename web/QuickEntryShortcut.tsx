import { useEffect, useState } from "react";
import { acceleratorFromKeyStroke, acceleratorLabel, parseAccelerator, QUICK_ENTRY_DEFAULT_SHORTCUT, type QuickShortcutStatus } from "../shared/quickEntry";
import { activeBindings, strokeOf } from "./keymap";
import { useQuickEntryStatus } from "./quickEntrySync";
import { rpc } from "./rpc";
import { claimKeys } from "./shortcuts";
import type { SettingsCtx } from "./settingsItems";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// Settings 의 빠른 입력창 단축키 행 컨트롤: 후보 목록에서 고르거나, 녹화 버튼을 누르고 새 키를 눌러 정한다. 아래에 전역 등록 결과가 보인다.
// 녹화는 Cmd 조합을 받지 않는다. Cmd 조합은 앱 메뉴와 단축키 표가 먼저 가로채서 녹화 중에 다른 명령이 실행된다. Cmd 를 쓰려면 후보 목록의 항목을 고른다.
const CANDIDATES = ["Alt+C", "Alt+Space", "Alt+Shift+C", "Control+Alt+C", "Control+Alt+Space", "Alt+Shift+Space", "CommandOrControl+Shift+Space"] as const;

export function QuickEntryShortcut({ ctx }: { ctx: SettingsCtx }) {
  const status = useQuickEntryStatus();
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const current = parseAccelerator(ctx.settings.quickEntryShortcut) ?? QUICK_ENTRY_DEFAULT_SHORTCUT;
  const options = (CANDIDATES as readonly string[]).includes(current) ? [...CANDIDATES] : [current, ...CANDIDATES];

  const save = (accelerator: string) => void rpc.call("settings.set", { quickEntryShortcut: accelerator });

  // 녹화 중에는 창 단계에서 키를 먼저 받고 다른 곳(Settings 를 닫는 Esc 포함)에 넘기지 않는다.
  // 앱 단축키 표에 있는 키는 받지 않는다: 전역 단축키가 되면 앱 안에서도 그 키를 가져가 원래 명령(⌃⌥R 세션 검색, ⌥Z 줄 바꿈 등)이 죽는다.
  // 그중 Electron 메인이 가로채는 키(⌥H, ⌃⌥R, ⌃⌥L 과 ⌘ 조합)는 keydown 없이 표로 바로 가서, 녹화 중에 그 명령이 실행되지 않게 claimKeys 로 먼저 받는다.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== "keydown" || ["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      if (e.key === "Escape") {
        setRecording(false);
        setHint(null);
        return;
      }
      const next = e.metaKey ? null : acceleratorFromKeyStroke({ code: e.code, metaKey: false, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
      if (!next) {
        setHint(S.quickEntryNeedModifier);
        return;
      }
      if (usedByApp(strokeOf(e))) {
        setHint(S.quickEntryKeyInApp);
        return;
      }
      setRecording(false);
      setHint(null);
      save(next);
    };
    const releaseKeys = claimKeys((stroke) => {
      setHint(stroke.includes("Meta") ? S.quickEntryNeedModifier : S.quickEntryKeyInApp);
      return true;
    });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      releaseKeys();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [recording]);

  return (
    <>
      <div className="setting-quick-shortcut">
        <Select value={current} onValueChange={save}>
          <SelectTrigger boxed className="setting-select" aria-label={S.settingText.quickEntryShortcut[0]}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((accelerator) => (
              <SelectItem key={accelerator} value={accelerator}>
                {acceleratorLabel(accelerator)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          aria-pressed={recording}
          onClick={() => {
            setHint(null);
            setRecording((on) => !on);
          }}
          onBlur={() => setRecording(false)}
        >
          {recording ? S.quickEntryRecording : S.quickEntryRecord}
        </Button>
      </div>
      {hint && (
        <div className="setting-warning" role="status">
          {hint}
        </div>
      )}
      <StatusLine status={status} />
    </>
  );
}

// 지금 프리셋의 단축키 표가 단독 키나 chord 의 첫 키로 쓰는 키인가
const usedByApp = (stroke: string | null) => !!stroke && activeBindings().some((b) => b.keys[0] === stroke);

function StatusLine({ status }: { status: QuickShortcutStatus | null }) {
  if (!status) return <div className="setting-empty">{S.quickEntryStatusNoApp}</div>;
  if (status.state === "failed") return <div className="setting-problem" role="alert">{status.reason === "invalid" ? S.quickEntryStatusInvalid : S.quickEntryStatusTaken}</div>;
  const text = status.state === "registered" ? S.quickEntryStatusRegistered : status.state === "off" ? S.quickEntryStatusOff : S.quickEntryStatusBlocked;
  return <div className="setting-empty">{text}</div>;
}
