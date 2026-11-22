import { LSPPlugin } from "@codemirror/lsp-client";
import { diagnosticsOf, type LspDiagnostic, type LspRange } from "./diagnosticsStore";
import { loadRelated, type RelatedLocation } from "./problemActions";
import { uriToPath } from "./lsp";
import { loadCodeActions } from "./quickFix";
import { partsFromHoverMarkdown } from "./hoverParts";
import { signatureFromParts, typeFromParts, type DisplayPart } from "./typeParts";

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

export async function loadTypeAt(plugin: LSPPlugin, pos: number) {
  plugin.client.sync();
  const hoverPromise = hoverContent(plugin, { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos) }).catch(() => null);
  const parts = await typeParts(plugin, pos, hoverPromise);
  return { type: parts ? typeFromParts(parts) : null, signature: parts ? signatureFromParts(parts) : null };
}

async function typeParts(plugin: LSPPlugin, pos: number, hover: Promise<{ markdown: string } | null>): Promise<DisplayPart[] | null> {
  if (hasTsserverRequest(plugin)) return quickInfoParts(plugin, pos).catch(() => null);
  const result = await hover;
  return result ? partsFromHoverMarkdown(result.markdown) : null;
}

function hasTsserverRequest(plugin: LSPPlugin) {
  const provider = plugin.client.serverCapabilities?.executeCommandProvider;
  return !!provider?.commands?.includes("typescript.tsserverRequest");
}

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

