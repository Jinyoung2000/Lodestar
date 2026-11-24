import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "design-system", "tokens.json");
const target = join(here, "..", "src", "theme", "tokens.generated.ts");

const MAP = {
  background: "pane-bg",
  surface: "surface-raised",
  surfaceBase: "surface-base",
  overlay: "surface-overlay",
  pressed: "surface-hover",
  selected: "surface-selected",
  separator: "border-subtle",
  border: "border",
  textStrong: "fg-strong",
  text: "fg",
  textMuted: "fg-muted",
  textSubtle: "fg-subtle",
  accent: "accent",
  onAccent: "accent-fg",
  accentText: "accent-text",
  running: "running",
  providerClaude: "provider-claude",
  providerCodex: "provider-codex",
  providerAntigravity: "provider-antigravity",
  providerCursor: "provider-cursor",
  success: "success",
  warning: "warning",
  danger: "danger",
  unread: "unread",
  userBubble: "chat-user-bg",
  inputBackground: "input-bg",
  inputBorder: "input-border",
  codeBackground: "surface-base",
  inlineCodeBackground: "inline-code-bg",
  inlineCodeText: "inline-code-fg",
  diffAdd: "diff-add-bg",
  diffDelete: "diff-del-bg",
};

const tokens = new Map(JSON.parse(readFileSync(source, "utf8")).color.tokens.map((t) => [t.name, t.value]));
const pick = (mode) => Object.fromEntries(Object.entries(MAP).map(([name, token]) => {
  const value = tokens.get(token);
  if (!value) throw new Error(`token ${token} is missing in tokens.json`);
  return [name, value[mode]];
}));

const body = `export const palette = ${JSON.stringify({ dark: pick("dark"), light: pick("light") }, null, 2)} as const;
export type PaletteName = keyof (typeof palette)["dark"];
`;
writeFileSync(target, body);
console.log(`wrote ${target}`);
