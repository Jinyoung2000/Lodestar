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

const CANDIDATES = ["Alt+C", "Alt+Space", "Alt+Shift+C", "Control+Alt+C", "Control+Alt+Space", "Alt+Shift+Space", "CommandOrControl+Shift+Space"] as const;

export function QuickEntryShortcut({ ctx }: { ctx: SettingsCtx }) {
  const status = useQuickEntryStatus();
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const current = parseAccelerator(ctx.settings.quickEntryShortcut) ?? QUICK_ENTRY_DEFAULT_SHORTCUT;
  const options = (CANDIDATES as readonly string[]).includes(current) ? [...CANDIDATES] : [current, ...CANDIDATES];

  const save = (accelerator: string) => void rpc.call("settings.set", { quickEntryShortcut: accelerator });

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

const usedByApp = (stroke: string | null) => !!stroke && activeBindings().some((b) => b.keys[0] === stroke);

function StatusLine({ status }: { status: QuickShortcutStatus | null }) {
  if (!status) return <div className="setting-empty">{S.quickEntryStatusNoApp}</div>;
  if (status.state === "failed") return <div className="setting-problem" role="alert">{status.reason === "invalid" ? S.quickEntryStatusInvalid : S.quickEntryStatusTaken}</div>;
  const text = status.state === "registered" ? S.quickEntryStatusRegistered : status.state === "off" ? S.quickEntryStatusOff : S.quickEntryStatusBlocked;
  return <div className="setting-empty">{text}</div>;
}
