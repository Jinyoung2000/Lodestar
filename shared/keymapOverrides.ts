import { KEYMAP_PRESETS, type CommandKeys, type KeymapOverrides } from "./protocol";

const STROKE = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?[A-Z][A-Za-z0-9]{0,20}$/;
const COMMAND = /^[A-Za-z][\w:.-]{0,79}$/;
const MAX_COMMANDS = 400;
const MAX_KEYS = 4;

export function isKeySequence(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const strokes = value.split(" ");
  return strokes.length <= 2 && strokes.every((stroke) => STROKE.test(stroke));
}

function sanitizeCommandKeys(value: unknown): CommandKeys | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([command, keys]) => COMMAND.test(command) && Array.isArray(keys) && keys.length <= MAX_KEYS && keys.every(isKeySequence))
    .slice(0, MAX_COMMANDS)
    .map(([command, keys]): [string, string[]] => [command, [...new Set(keys as string[])]]);
  return Object.fromEntries(entries);
}

export function sanitizeKeymapOverrides(value: unknown): KeymapOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: KeymapOverrides = {};
  for (const preset of KEYMAP_PRESETS) {
    const commands = sanitizeCommandKeys((value as Record<string, unknown>)[preset]);
    if (commands && Object.keys(commands).length) result[preset] = commands;
  }
  return result;
}
