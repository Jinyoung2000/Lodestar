// 디자인 시스템 일관성 검사. web/ 의 CSS 와 TSX 에서 토큰을 거치지 않은 값을 찾으면 실패한다.
//  - raw px (1px 테두리만 허용)
//  - hex 색, rgb()/rgba()/hsl() 색
//  - 디자인 시스템에 없는 Tailwind 간격 단계 (p-5, mt-10, gap-7 …)와 임의값 클래스 (p-[10px], w-[13px])
// 꼭 필요한 예외는 그 줄이나 바로 윗줄에 `lint-tokens: allow <이유>` 주석을 단다. 생성 파일(web/tokens.css)은 건너뛴다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [join(root, "web")];
const extra = process.argv.slice(2).map((p) => join(root, p));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(css|tsx|ts)$/.test(name)) files.push(path);
  }
};
for (const t of targets) walk(t);
for (const e of extra) files.push(e);

// 디자인 시스템의 간격 단계 (Tailwind 클래스 이름 기준)
const SPACING_STEPS = new Set(["0", "0.5", "1", "1.5", "2", "3", "4", "6", "8", "px"]);
const SPACING_PREFIXES = "p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|bottom|left|right|start|end|indent|scroll-m|scroll-p";

const RULES = [
  { name: "raw px", re: /(?<![\w.-])(\d*\.?\d+)px\b/g, ok: (m) => m[1] === "1" || m[1] === "0" },
  { name: "hex 색", re: /#[0-9a-fA-F]{3,8}\b(?![\w-])/g, ok: () => false },
  { name: "rgb/hsl 색", re: /\b(?:rgba?|hsla?)\(/g, ok: () => false },
  { name: "임의값 Tailwind 클래스", re: /(?<=[\s"'`])(?:[a-z-]+)-\[[^\]]*(?:px|rem|em|%|#)[^\]]*\]/g, ok: () => false },
  {
    name: "디자인 시스템에 없는 Tailwind 간격",
    re: new RegExp(`(?<=[\\s"'\`])-?(?:${SPACING_PREFIXES})-(\\d+(?:\\.\\d+)?)(?=[\\s"'\`])`, "g"),
    ok: (m) => SPACING_STEPS.has(m[1]),
  },
];

const problems = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (/lint-tokens:\s*generated/.test(text)) continue;
  const rel = relative(root, file);
  const isCss = file.endsWith(".css");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const prev = lines[i - 1] ?? "";
    if (/lint-tokens:\s*allow/.test(line) || /lint-tokens:\s*allow/.test(prev)) return;
    // 주석 줄은 보지 않는다 (CSS 주석, // 주석)
    const code = isCss ? line.replace(/\/\*.*?\*\//g, "") : line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    for (const rule of RULES) {
      // Tailwind 클래스 규칙은 className 문자열이 있는 TSX 에만, px/색 규칙은 둘 다
      if (rule.name.includes("Tailwind") && isCss) continue;
      for (const m of code.matchAll(rule.re)) {
        if (rule.ok(m)) continue;
        problems.push(`${rel}:${i + 1}: ${rule.name} "${m[0]}"`);
      }
    }
  });
}

if (problems.length) {
  console.error(`lint:tokens 실패 (${problems.length}건)`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`lint:tokens 통과 (${files.length}개 파일)`);
