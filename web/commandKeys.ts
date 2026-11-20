import { keycapsOf } from "./commands";
import { bindingsFor, type Binding } from "./keymap";
import { commandKeyLabel, commandKeyLabels, preferredBinding } from "./shortcutList";
import { useStore } from "./store";

export function useBindings(): Binding[] {
  const preset = useStore((s) => s.settings?.keymapPreset ?? "vscode");
  const overrides = useStore((s) => s.settings?.keymapOverrides?.[preset]);
  return bindingsFor(preset, overrides);
}

export function useCommandKey(command: string): string | null {
  return commandKeyLabel(command, useBindings());
}

export function useCommandKeys(command: string): string[] {
  return commandKeyLabels(command, useBindings());
}

export function useCommandKeycaps(command: string): string[] {
  const binding = preferredBinding(command, useBindings());
  return binding ? keycapsOf(binding) : [];
}

export function useAriaKeyShortcut(command: string): string | undefined {
  const binding = preferredBinding(command, useBindings());
  return binding ? binding.keys.map((stroke) => stroke.replace(/(^|\+)(Key|Digit)/, "$1")).join(" ") : undefined;
}
