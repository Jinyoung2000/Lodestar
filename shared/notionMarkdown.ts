
export type NotionBlock = {
  type: string;
  text?: string;
  level?: number;
  checked?: boolean;
  lang?: string;
  href?: string;
  rows?: string[][];
  children?: NotionBlock[];
};

export const MAX_NOTION_CHARS = 20000;

export type NotionPageText = { markdown: string; truncated: boolean; chars: number };

export function notionPageText(blocks: NotionBlock[], max = MAX_NOTION_CHARS): NotionPageText {
  const full = renderBlocks(blocks, "").join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (full.length <= max) return { markdown: full, truncated: false, chars: full.length };
  const cut = full.slice(0, max);
  const lineEnd = cut.lastIndexOf("\n");
  return { markdown: (lineEnd > max * 0.5 ? cut.slice(0, lineEnd) : cut).trimEnd(), truncated: true, chars: full.length };
}

function renderBlocks(blocks: NotionBlock[], indent: string): string[] {
  const lines: string[] = [];
  let numbered = 0;
  let previous: string | null = null;
  for (const block of blocks) {
    numbered = block.type === "number" ? numbered + 1 : 0;
    const out = renderBlock(block, indent, numbered);
    if (out.length === 0) continue;
    if (lines.length > 0 && !(previous !== null && listFamily(block.type) !== null && listFamily(block.type) === listFamily(previous))) lines.push("");
    lines.push(...out);
    previous = block.type;
  }
  return lines;
}

const listFamily = (type: string) => (type === "number" ? "number" : type === "bullet" || type === "todo" || type === "toggle" ? "bullet" : null);

function renderBlock(block: NotionBlock, indent: string, index: number): string[] {
  const text = (block.text ?? "").trim();
  const children = block.children ?? [];
  switch (block.type) {
    case "heading":
      return text ? [`${indent}${"#".repeat(Math.min(Math.max(block.level ?? 1, 1), 3))} ${oneLine(text)}`, ...renderBlocks(children, indent)] : renderBlocks(children, indent);
    case "bullet":
    case "toggle":
    case "todo":
    case "number": {
      const marker = block.type === "number" ? `${index}. ` : block.type === "todo" ? `- [${block.checked ? "x" : " "}] ` : "- ";
      const body = text.split("\n");
      const own = body.map((line, i) => (i === 0 ? `${indent}${marker}${line}` : `${indent}${" ".repeat(marker.length)}${line}`));
      if (!text) own.length = 0;
      return [...own, ...renderBlocks(children, indent + " ".repeat(marker.length))];
    }
    case "quote":
    case "callout": {
      const inner = [...(text ? text.split("\n") : []), ...(children.length ? [...(text ? [""] : []), ...renderBlocks(children, "")] : [])];
      return inner.map((line) => `${indent}> ${line}`.trimEnd());
    }
    case "code": {
      const code = block.text ?? "";
      const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
      return [`${indent}${fence}${block.lang ?? ""}`, ...code.replace(/\n$/, "").split("\n").map((l) => `${indent}${l}`), `${indent}${fence}`];
    }
    case "divider":
      return [`${indent}---`];
    case "table":
      return renderTable(block.rows ?? [], indent);
    case "image":
      return [`${indent}[Image${text ? `: ${oneLine(text)}` : ""}]`];
    case "embed":
      return [`${indent}[Embedded content${text ? `: ${oneLine(text)}` : ""}${block.href ? ` (${block.href})` : ""}]`];
    case "link":
    case "page":
    case "database": {
      const label = oneLine(text) || block.href || "Untitled";
      const prefix = block.type === "database" ? "Database: " : block.type === "page" ? "Page: " : "";
      const own = block.href ? [`${indent}[${prefix}${label}](${block.href})`] : [`${indent}${prefix}${label}`];
      return [...own, ...renderBlocks(children, indent + (children.length ? "  " : ""))];
    }
    default: {
      const own = text ? text.split("\n").map((line) => `${indent}${line}`) : [];
      return [...own, ...renderBlocks(children, indent)];
    }
  }
}

function renderTable(rows: string[][], indent: string): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length), 1);
  const cell = (value: string | undefined) => oneLine(value ?? "").replace(/\|/g, "\\|");
  const line = (row: string[]) => `${indent}| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(" | ")} |`;
  return [line(rows[0]), `${indent}| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)];
}

const oneLine = (value: string) => value.replace(/\s*\n\s*/g, " ").trim();

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}
