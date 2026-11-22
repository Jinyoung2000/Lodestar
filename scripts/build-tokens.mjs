import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIfChanged } from "./writeIfChanged.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(join(root, "design-system/tokens.json"), "utf8"));

const lines = [];
const push = (s) => lines.push(s);

push("/* lint-tokens: generated */");

const colorVars = (theme) => tokens.color.tokens.map((t) => `  --${t.name}: ${t.value[theme]};`).join("\n");
const shadowVars = (theme) => tokens.shadow.tokens.map((t) => `  --${t.name}: ${t.value[theme]};`).join("\n");

const shadcn = [
  ["background", "surface-raised"],
  ["foreground", "fg"],
  ["card", "surface-overlay"],
  ["card-foreground", "fg"],
  ["popover", "surface-overlay"],
  ["popover-foreground", "fg"],
  ["primary", "accent"],
  ["primary-foreground", "accent-fg"],
  ["secondary", "surface-hover"],
  ["secondary-foreground", "fg-strong"],
  ["accent", "surface-hover"],
  ["accent-foreground", "fg-strong"],
  ["muted", "surface-base"],
  ["muted-foreground", "fg-muted"],
  ["border", "border"],
  ["input", "border"],
  ["ring", "accent"],
  ["destructive", "danger"],
];

push(":root {");
push(colorVars("dark"));
push(shadowVars("dark"));
push(`  --font-sans: ${tokens.type.families.sans};`);
push(`  --font-mono: ${tokens.type.families.mono};`);
for (const t of tokens.spacing.tokens) push(`  --${t.name}: ${t.value};`);
for (const t of tokens.size.tokens) push(`  --${t.name}: ${t.value};`);
for (const t of tokens.radius.tokens) push(`  --${t.name}: ${t.value};`);
for (const group of tokens.type.groups) {
  for (const s of group.styles) {
    push(`  --text-${s.name}: ${s.fontSize};`);
    push(`  --leading-${s.name}: ${s.lineHeight};`);
    push(`  --weight-${s.name}: ${s.fontWeight};`);
  }
}
const tokenNames = new Set(tokens.color.tokens.map((t) => t.name));
for (const [shad, ours] of shadcn) {
  if (tokenNames.has(shad)) continue;
  push(`  --${shad}: var(--${ours});`);
}
push(`  --radius: var(--radius-md);`);
push("  color-scheme: dark;");
push("}");
push("");
push(`[data-theme="light"] {`);
push(colorVars("light"));
push(shadowVars("light"));
push("  color-scheme: light;");
push("}");

const styleVars = (style, theme) =>
  tokens.color.tokens
    .filter((t) => t.value[`${style}-${theme}`] !== undefined)
    .map((t) => `  --${t.name}: ${t.value[`${style}-${theme}`]};`)
    .join("\n");
for (const style of tokens.color.styles.filter((s) => s.id !== "lodestar")) {
  push("");
  push(`[data-style="${style.id}"]:not([data-theme="light"]) {`);
  push(styleVars(style.id, "dark"));
  push("}");
  push("");
  push(`[data-style="${style.id}"][data-theme="light"] {`);
  push(styleVars(style.id, "light"));
  push("}");
}

writeIfChanged(join(root, "web/tokens.css"), lines.join("\n") + "\n");
console.log(`web/tokens.css: 색 ${tokens.color.tokens.length}, 간격 ${tokens.spacing.tokens.length}, 크기 ${tokens.size.tokens.length}, 반경 ${tokens.radius.tokens.length}, 글자 ${tokens.type.groups.reduce((n, g) => n + g.styles.length, 0)}`);
