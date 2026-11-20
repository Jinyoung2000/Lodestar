import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import type { Harness, PermissionMode } from "../shared/protocol";
import { CODEX_MODE_NOTES, codexSupportsMode } from "../shared/codexPermission"; // CODEX
import { PermissionAsk, PermissionAuto, PermissionBypass, PermissionEdits, PermissionPlan } from "./icons";
import { Popup } from "./Popup";
import { S } from "./strings";

export const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = (["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const).map((value) => ({
  value,
  label: S.permissionModes[value],
  description: S.permissionDescriptions[value],
}));

// ⇧Tab 이 도는 순서. 세션을 늘 allowDangerouslySkipPermissions 로 띄우므로(server/agents.ts) Claude Code 의 bypass 허용 세션처럼 bypassPermissions 까지 돈다.
// Codex 에 없는 모드(plan)는 건너뛴다.
const CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
export function nextPermissionMode(mode: PermissionMode, harness: Harness = "claude"): PermissionMode {
  const modes = harness === "codex" ? CYCLE.filter(codexSupportsMode) : CYCLE;
  return modes[(modes.indexOf(mode) + 1) % modes.length];
}

export function PermissionRow({ mode, onChange, tip, harness = "claude" }: { mode: PermissionMode; onChange: (mode: PermissionMode) => void; tip: HTMLAttributes<HTMLElement>; harness?: Harness }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode;
  useEffect(() => {
    if (open) menuRef.current?.querySelectorAll<HTMLElement>(".permission-option")[active]?.focus();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <button ref={buttonRef} type="button" className="chip permission-row" data-chip="permission" data-tone={mode === "bypassPermissions" ? "warn" : undefined} aria-haspopup="menu" aria-expanded={open} {...tip} onClick={() => {
          setActive(Math.max(0, PERMISSION_MODES.findIndex((m) => m.value === mode)));
          setOpen((v) => !v);
        }}>
        <PermissionModeIcon mode={mode} size={16} />
        <span className="chip-label permission-label">{label}</span>
      </button>
      {open && (
        <Popup anchor={buttonRef.current} placement="above" label={S.permissionMenuAria} className="popup-permission" onClose={() => setOpen(false)}>
          <div
            role="menu"
            ref={menuRef}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const next = Math.min(PERMISSION_MODES.length - 1, Math.max(0, active + (e.key === "ArrowDown" ? 1 : -1)));
              setActive(next);
              menuRef.current?.querySelectorAll<HTMLElement>(".permission-option")[next]?.focus();
            }}
          >
            {PERMISSION_MODES.map((m, index) => (
              <button
                key={m.value}
                type="button"
                role="menuitem"
                className="permission-option"
                data-active={index === active || undefined}
                data-tone={m.value === "bypassPermissions" ? "warn" : undefined}
                disabled={harness === "codex" && !codexSupportsMode(m.value)}
                title={harness === "codex" ? CODEX_MODE_NOTES[m.value] : undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  setOpen(false);
                  onChange(m.value);
                }}
              >
                <PermissionModeIcon mode={m.value} size={12} />
                <span className="permission-option-name">{m.label}</span>
                <span className="permission-option-description">{harness === "codex" ? S.permissionDescriptionsCodex[m.value] : m.description}</span>
              </button>
            ))}
          </div>
          {harness === "claude" && (
            <>
              <div className="popup-separator" />
              <button type="button" className="permission-option permission-learn" onClick={() => window.open(S.permissionsDocsUrl, "_blank", "noopener")}>
                <span className="permission-option-name">{S.learnMorePermissions}</span>
              </button>
            </>
          )}
        </Popup>
      )}
    </>
  );
}

// 권한 모드마다 아이콘 하나. 줄과 메뉴 항목이 같은 기호를 쓴다.
export function PermissionModeIcon({ mode, size = 16 }: { mode: PermissionMode; size?: number }) {
  if (mode === "acceptEdits") return <PermissionEdits size={size} />;
  if (mode === "plan") return <PermissionPlan size={size} />;
  if (mode === "auto") return <PermissionAuto size={size} />;
  if (mode === "bypassPermissions") return <PermissionBypass size={size} />;
  return <PermissionAsk size={size} />;
}
