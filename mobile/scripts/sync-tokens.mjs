// Lodestar 의 색 토큰(design-system/tokens.json)에서 모바일이 쓰는 색만 뽑아 src/theme/tokens.generated.ts 를 만든다.
// 값은 손으로 고치지 않는다. 토큰이 바뀌면 `npm run tokens` 를 다시 돌린다.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "design-system", "tokens.json");
const target = join(here, "..", "src", "theme", "tokens.generated.ts");

// 모바일 이름 -> Lodestar 토큰 이름
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

const body = `// 생성 파일: scripts/sync-tokens.mjs 가 design-system/tokens.json 에서 만든다. 직접 고치지 않는다.
export const palette = ${JSON.stringify({ dark: pick("dark"), light: pick("light") }, null, 2)} as const;
export type PaletteName = keyof (typeof palette)["dark"];
`;
writeFileSync(target, body);
console.log(`wrote ${target}`);
