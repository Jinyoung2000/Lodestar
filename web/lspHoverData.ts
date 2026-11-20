import { LSPPlugin } from "@codemirror/lsp-client";
import { diagnosticsOf, type LspDiagnostic, type LspRange } from "./diagnosticsStore";
import { loadRelated, type RelatedLocation } from "./problemActions";
import { uriToPath } from "./lsp";
import { loadCodeActions } from "./quickFix";
import { partsFromHoverMarkdown } from "./hoverParts";
import { signatureFromParts, typeFromParts, type DisplayPart } from "./typeParts";

// hover 상자 하나를 채우는 서버 응답을 모은다: hover 본문, 그 자리의 진단, quick fix 가 있는지, 붙여넣을 수 있는 타입과 시그니처.
export type HoverData = {
  html: string | null;
  range?: LspRange;
  diagnostics: LspDiagnostic[];
  hasFixes: boolean;
  related: RelatedLocation[];
  type: string | null;
  signature: string | null;
};

type HoverContents = string | { language: string; value: string } | { kind: "plaintext" | "markdown"; value: string } | (string | { language: string; value: string })[];

export async function loadHoverData(plugin: LSPPlugin, pos: number, workspaceId: string): Promise<HoverData> {
  plugin.client.sync();
  const params = { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos) };
  const diagnostics = diagnosticsAt(plugin, pos);
  const hoverPromise = hoverContent(plugin, params).catch(() => null);
  const [hover, parts, fixes, related] = await Promise.all([
    hoverPromise,
    typeParts(plugin, pos, hoverPromise),
    diagnostics.length ? loadCodeActions(plugin, rangeOfDiagnostics(diagnostics), diagnostics).catch(() => []) : Promise.resolve([]),
    loadRelated(workspaceId, diagnostics).catch(() => []),
  ]);
  return {
    html: hover?.html ?? null,
    range: hover?.range,
    diagnostics,
    hasFixes: fixes.length > 0,
    related,
    type: parts ? typeFromParts(parts) : null,
    signature: parts ? signatureFromParts(parts) : null,
  };
}

// 커서 위치의 타입과 시그니처만(Copy Type 명령, 우클릭 메뉴)
export async function loadTypeAt(plugin: LSPPlugin, pos: number) {
  plugin.client.sync();
  const hoverPromise = hoverContent(plugin, { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos) }).catch(() => null);
  const parts = await typeParts(plugin, pos, hoverPromise);
  return { type: parts ? typeFromParts(parts) : null, signature: parts ? signatureFromParts(parts) : null };
}

// typescript-language-server 는 tsserver 의 quickinfo-full 을 workspace/executeCommand 로 열어 준다. 네이티브 TypeScript(typescript-go) 는 그 명령이 없어
// 이미 받은 hover 마크다운의 코드 블록에서 같은 조각을 만든다(web/hoverParts.ts).
async function typeParts(plugin: LSPPlugin, pos: number, hover: Promise<{ markdown: string } | null>): Promise<DisplayPart[] | null> {
  if (hasTsserverRequest(plugin)) return quickInfoParts(plugin, pos).catch(() => null);
  const result = await hover;
  return result ? partsFromHoverMarkdown(result.markdown) : null;
}

function hasTsserverRequest(plugin: LSPPlugin) {
  const provider = plugin.client.serverCapabilities?.executeCommandProvider;
  return !!provider?.commands?.includes("typescript.tsserverRequest");
}

// typescript-language-server 의 typescript.tsserverRequest 로 quickinfo-full 을 부른다. displayParts 는 이 요청에만 있다(LSP hover 는 마크다운 문자열뿐).
// 이 요청의 표시 문자열은 잘리지 않는다(확인: 20개 유니온, 8단계 중첩 객체 모두 전체).
async function quickInfoParts(plugin: LSPPlugin, pos: number): Promise<DisplayPart[] | null> {
  const position = plugin.toPosition(pos);
  const result = await plugin.client.request<object, { body?: { displayParts?: DisplayPart[] }; displayParts?: DisplayPart[] } | null>("workspace/executeCommand", {
    command: "typescript.tsserverRequest",
    arguments: ["quickinfo-full", { file: uriToPath(plugin.uri), line: position.line + 1, offset: position.character + 1 }, {}],
  });
  return result?.body?.displayParts ?? result?.displayParts ?? null;
}

export async function hoverContent(plugin: LSPPlugin, params: object): Promise<{ html: string; markdown: string; range?: LspRange } | null> {
  if (plugin.client.serverCapabilities && !plugin.client.serverCapabilities.hoverProvider) return null;
  const result = await plugin.client.request<object, { contents: HoverContents; range?: LspRange } | null>("textDocument/hover", params);
  if (!result) return null;
  return { html: hoverHtml(plugin, result.contents), markdown: hoverMarkdown(result.contents), range: result.range };
}

function hoverMarkdown(contents: HoverContents) {
  const markdown = (item: string | { language: string; value: string }) => (typeof item === "string" ? item : `\`\`\`${item.language}\n${item.value}\n\`\`\``);
  if (Array.isArray(contents)) return contents.map(markdown).join("\n\n");
  if (typeof contents === "string" || "language" in contents) return markdown(contents);
  return contents.value;
}

function hoverHtml(plugin: LSPPlugin, contents: HoverContents) {
  if (typeof contents === "object" && !Array.isArray(contents) && "kind" in contents) return plugin.docToHTML(contents);
  return plugin.docToHTML(hoverMarkdown(contents), "markdown");
}

// pos 에 걸치는 서버 진단. 범위는 서버가 마지막으로 본 문서 기준이라 아직 보내지 않은 편집만큼 옮긴다(lsp-client 의 진단 처리와 같은 계산).
export function diagnosticsAt(plugin: LSPPlugin, pos: number): LspDiagnostic[] {
  return diagnosticsOf(plugin.uri).filter((d) => {
    const from = plugin.unsyncedChanges.mapPos(plugin.fromPosition(d.range.start, plugin.syncedDoc));
    const to = plugin.unsyncedChanges.mapPos(plugin.fromPosition(d.range.end, plugin.syncedDoc));
    return from <= pos && pos <= to;
  });
}

function rangeOfDiagnostics(diagnostics: LspDiagnostic[]): LspRange {
  return diagnostics[0]!.range;
}

