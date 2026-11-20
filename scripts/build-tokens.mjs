// design-system/tokens.json 을 읽어 web/tokens.css 를 만든다. 토큰이 코드의 단일 원본이라 손으로 고치지 않는다.
// 다크가 :root 기본, 라이트는 [data-theme="light"], 색 스타일(WebStorm)은 [data-style] 덮어쓰기. shadcn/ui 변수는 README 의 "shadcn/ui 로 옮기기" 표대로 토큰에 잇는다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIfChanged } from "./writeIfChanged.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(join(root, "design-system/tokens.json"), "utf8"));

const lines = [];
const push = (s) => lines.push(s);

push("/* 생성 파일. scripts/build-tokens.mjs 가 design-system/tokens.json 에서 만든다. 직접 고치지 않는다. */");
push("/* lint-tokens: generated */");

// 색: 테마별
const colorVars = (theme) => tokens.color.tokens.map((t) => `  --${t.name}: ${t.value[theme]};`).join("\n");
const shadowVars = (theme) => tokens.shadow.tokens.map((t) => `  --${t.name}: ${t.value[theme]};`).join("\n");

// shadcn/ui 변수 연결표 (README)
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
// 디자인 토큰과 이름이 겹치는 shadcn 변수(accent, border)는 내지 않는다. 같은 블록 뒤에 오면 토큰을 덮어
// 다크의 --accent 가 surface-hover 가 되고(2026-10-14 발견), --border: var(--border) 는 자기 참조로 무효가 된다.
// 그 이름들은 토큰 값이 그대로 shadcn 의미와 같거나(border) 우리 컴포넌트가 토큰 뜻으로 쓴다(accent = 주요 색).
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

// 색 스타일(data-style): 기본 스타일(lodestar)과 값이 다른 토큰만 `<스타일>-dark`, `<스타일>-light` 키로 가진다. 키가 없으면 기본 값 그대로다.
// 다크 블록은 :not([data-theme="light"]) 로 라이트에 새지 않게 하고, 라이트 블록은 속성 선택자 둘(0,2,0)이라 위의 [data-theme="light"](0,1,0)를 순서와 상관없이 이긴다.
// color-scheme 은 밝기가 정하므로 여기서 내지 않는다.
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
