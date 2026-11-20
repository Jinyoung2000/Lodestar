import { asideImageRefs, withoutImageNotes } from "../shared/asideTool";

// Aside 호출(mcp__aside__repl) 한 줄에 보일 값을 호출 항목에서 뽑는 순수 함수. 화면(web/AsideStepRow.tsx)과 시험(test/asideview.test.ts)이 쓴다.
export type AsideState = "running" | "ok" | "error" | "empty";
export type AsideSummary = {
  title: string;
  url: string | null;
  state: AsideState;
  // 접힌 줄에 보이는 짧은 결과. 오류면 오류 첫 줄.
  preview: string;
  // 이미지 안내 줄을 뺀 결과 글
  text: string;
  textLines: number;
  // 결과 글이 길면 펼친 뒤에도 한 번 더 접어 둔다
  long: boolean;
  images: string[][];
};

type Input = { input: Record<string, unknown>; output: string | null; status: "running" | "done" | "error"; shots?: string[] };

const NO_OUTPUT = /^\(mcp__aside__repl completed with no output\)$/;
const LONG_LINES = 12;
const LONG_CHARS = 1200;

export function asideTitle(input: Record<string, unknown>): string {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (title) return title;
  const code = typeof input.code === "string" ? input.code : "";
  const line = code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
  return line ? line.slice(0, 120) : "";
}

// 결과 글의 첫 주소. 결과에 없으면(진행 중이거나 출력이 없는 호출) 코드가 여는 주소.
export function asideUrl(output: string | null, code: string | null): string | null {
  const clean = (url: string) => url.replace(/[.,;:)\]'"]+$/, "");
  const found = output ? /https?:\/\/[^\s)\]"'<>`]+/.exec(withoutImageNotes(output)) : null;
  if (found) return clean(found[0]);
  const opened = code ? /\b(?:openTab|goto|newPage|navigate)\w*\(\s*['"`](https?:\/\/[^'"`\s]+)/.exec(code) : null;
  return opened ? clean(opened[1]) : null;
}

// 줄에 보일 주소: 프로토콜과 끝의 / 를 뗀다
export const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

// 접힌 줄에 보일 첫 줄. [system] 경고, 주소만 있는 줄(주소는 따로 보인다)은 건너뛰고, 줄 안의 같은 주소 표기("(주소)", "[url=주소]")는 뗀다.
function firstLine(text: string, url: string | null = null): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^\[system\]/i.test(line) || (url && line === url)) continue;
    const shown = url ? line.split(`(${url})`).join("").split(`[url=${url}]`).join("").replace(/\s+/g, " ").trim() : line;
    if (shown) return shown;
  }
  return "";
}

export function asideSummary(item: Input): AsideSummary {
  const code = typeof item.input.code === "string" ? item.input.code : null;
  const refs = asideImageRefs(item.output);
  const images = item.shots?.length ? item.shots.map((path) => [path]) : refs;
  const text = item.output ? withoutImageNotes(item.output) : "";
  const textLines = text ? text.split("\n").length : 0;
  const base = { title: asideTitle(item.input), url: asideUrl(item.output, code), text, textLines, long: textLines > LONG_LINES || text.length > LONG_CHARS, images };
  if (item.status === "running") return { ...base, state: "running", preview: "" };
  if (item.status === "error") {
    // "Error: Error: ..." 처럼 겹친 접두어는 한 번만 남긴다
    const line = firstLine(text).replace(/^(?:Error:\s*)+/i, "").trim();
    return { ...base, state: "error", preview: line };
  }
  if (!text || NO_OUTPUT.test(text)) return { ...base, state: images.length ? "ok" : "empty", preview: "" };
  const line = firstLine(text, base.url).replace(/^✔︎\s*/, "");
  return { ...base, state: "ok", preview: line.length > 160 ? `${line.slice(0, 160)}...` : line };
}
