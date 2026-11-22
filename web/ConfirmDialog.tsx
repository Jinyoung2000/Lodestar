import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef, useState, useSyncExternalStore } from "react";
import { Codicon } from "./icons";
import { dismissEditorWidgets } from "./editorWidgets";
import { setState, getState } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

export type ConfirmInput = { initial: string; placeholder: string; label: string; validate?: (value: string) => string | null | Promise<string | null> };
export type ConfirmOptions = { title: string; detail?: string; buttons: string[]; checkbox?: string; input?: ConfirmInput; severity?: "info" | "warning"; primary?: number; danger?: number[] };

type Pending = ConfirmOptions & { opener: HTMLElement | null; resolve: (choice: number | null, checked: boolean, value: string) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();

export function confirmDialog(options: ConfirmOptions): Promise<number | null> {
  return confirmWithCheckbox(options).then((result) => result.choice);
}

export function confirmWithCheckbox(options: ConfirmOptions): Promise<{ choice: number | null; checked: boolean; value: string }> {
  return new Promise((resolve) => {
    pending?.resolve(null, false, "");
    dismissEditorWidgets();
    pending = { ...options, opener: openerElement(), resolve: (choice, checked, value) => resolve({ choice, checked, value }) };
    emit();
  });
}

function openerElement(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body || active.closest(".confirm-dialog")) return null;
  const menu = active.closest("[role=menu]");
  const labelledBy = menu?.getAttribute("aria-labelledby");
  return (labelledBy ? document.getElementById(labelledBy) : null) ?? active;
}

function restoreFocus(opener: HTMLElement | null) {
  if (opener?.isConnected && !opener.hasAttribute("disabled")) {
    opener.focus();
    return;
  }
  if (document.activeElement === document.body || document.activeElement === null) setState({ focusComposer: { paneId: getState().activePaneId, nonce: Date.now() } });
}

export async function promptText(title: string, confirmLabel: string, input: ConfirmInput, detail?: string): Promise<string | null> {
  const result = await confirmWithCheckbox({ title, detail, buttons: [S.cancel, confirmLabel], input });
  return result.choice === 1 ? result.value : null;
}

export async function confirmAction(title: string, confirmLabel: string, detail?: string, severity?: "info" | "warning"): Promise<boolean> {
  return (await confirmDialog({ title, detail, buttons: [S.cancel, confirmLabel], severity })) === 1;
}

export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, () => pending);
  const contentRef = useRef<HTMLDivElement>(null);
  const [checked, setChecked] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<Pending | null>(null);
  const selectedFor = useRef<Pending | null>(null);
  const selectInitial = (el: HTMLInputElement | null) => {
    if (!el || !current || selectedFor.current === current) return;
    selectedFor.current = current;
    if (el.value) el.select();
  };
  const closedOpener = useRef<HTMLElement | null>(null);
  if (current) closedOpener.current = current.opener;
  if (current !== shown.current) {
    shown.current = current;
    if (current) {
      setValue(current.input?.initial ?? "");
      setError(null);
    }
  }
  const close = (choice: number | null) => {
    current?.resolve(choice, checked, value);
    pending = null;
    setChecked(false);
    emit();
  };
  const press = async (index: number) => {
    const primary = index === primaryIndex(current);
    if (primary && current?.input?.validate) {
      const problem = await current.input.validate(value);
      if (problem) {
        setError(problem);
        return;
      }
    }
    close(index);
  };
  return (
    <DialogPrimitive.Root open={!!current} onOpenChange={(open) => !open && close(null)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="confirm-overlay" />
        <DialogPrimitive.Content
          ref={contentRef}
          className="confirm-dialog"
          aria-describedby={current?.detail ? "confirm-detail" : undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            restoreFocus(closedOpener.current);
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.querySelector<HTMLElement>(current?.input ? "input" : "[data-primary]")?.focus();
          }}
        >
          <span className="confirm-icon" data-severity={current?.severity ?? "info"}>
            <Codicon name={current?.severity === "warning" ? "warning" : "info"} size={24} />
          </span>
          <DialogPrimitive.Title className="confirm-title">{current?.title}</DialogPrimitive.Title>
          <DialogPrimitive.Close className="confirm-close" aria-label={S.cancel}>
            <Codicon name="close" />
          </DialogPrimitive.Close>
          {current?.detail && (
            <DialogPrimitive.Description id="confirm-detail" className="confirm-detail">
              {current.detail}
            </DialogPrimitive.Description>
          )}
          {current?.input && (
            <div className="confirm-input">
              <input
                className="input mono"
                ref={selectInitial}
                autoFocus
                aria-label={current.input.label}
                placeholder={current.input.placeholder}
                value={value}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void press(primaryIndex(current));
                  }
                }}
              />
              {error && (
                <div className="confirm-input-error" role="alert">
                  {error}
                </div>
              )}
            </div>
          )}
          {current?.checkbox && (
            <label className="confirm-check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              {current.checkbox}
            </label>
          )}
          <div className="confirm-buttons">
            {current?.buttons.map((label, index) => {
              const primary = index === primaryIndex(current);
              return (
                <Button key={label} variant={primary ? "primary" : "secondary"} data-primary={primary || undefined} data-danger={current.danger?.includes(index) || undefined} onClick={() => void press(index)}>
                  {label}
                </Button>
              );
            })}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const primaryIndex = (options: ConfirmOptions | null) => options?.primary ?? (options?.buttons.length ?? 1) - 1;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}
