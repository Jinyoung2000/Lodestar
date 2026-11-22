import { LSPPlugin } from "@codemirror/lsp-client";
import { highlightingFor } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { hoverTooltip, type EditorView, type Tooltip } from "@codemirror/view";
import { highlightCode } from "@lezer/highlight";
import { diagnosticLabel } from "./diagnosticsStore";
import { modifierField, setLink, setModifier, type Link, type Preview } from "./definitionLinkState";
import { loadHoverData, type HoverData } from "./lspHoverData";
import { activeBindings } from "./keymap";
import { highlightLanguageFor } from "./lsp";
import { viewProblem } from "./markerView";
import { explainProblem, fixWithClaude, openRelated, problemContext } from "./problemActions";
import { openQuickFix } from "./quickFix";
import { commandKeyLabel, strokeLabel } from "./shortcutList";
import { S } from "./strings";
import { copyResult } from "./typeCopy";


export function lspHover(workspaceId: string): Extension {
  return hoverTooltip(
    async (view, pos) => {
      const plugin = LSPPlugin.get(view);
      if (!plugin || view.state.field(modifierField)) return null;
      const data = await loadHoverData(plugin, pos, workspaceId);
      if (!data.html && !data.diagnostics.length) return null;
      return {
        pos: data.range ? plugin.fromPosition(data.range.start) : pos,
        end: data.range ? plugin.fromPosition(data.range.end) : pos,
        above: true,
        create: (v) => ({ dom: hoverBox(v, data, null, pos, workspaceId) }),
      };
    },
    { hideOn: (tr) => tr.docChanged || tr.effects.some((e) => (e.is(setModifier) && e.value) || (e.is(setLink) && e.value !== null)) },
  );
}

export function linkTooltip(link: Link | null, workspaceId: string): Tooltip | null {
  const preview = link?.preview && link.preview.text.trim() ? link.preview : null;
  if (!link || (!link.hover?.html && !link.hover?.diagnostics.length && !preview)) return null;
  return {
    pos: link.from,
    end: link.to,
    above: true,
    arrow: false,
    create: (view) => ({ dom: hoverBox(view, link.hover, preview, link.from, workspaceId) }),
  };
}

function hoverBox(view: EditorView, data: HoverData | null, preview: Preview | null, pos: number, workspaceId: string) {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
  if (data?.diagnostics.length) dom.append(diagnosticsBlock(data));
  if (data?.related.length) dom.append(relatedBlock(data));
  if (data?.html) {
    const block = block_("cm-hover-section");
    block.innerHTML = data.html;
    dom.append(block);
  }
  if (preview) dom.append(previewBlock(view, preview));
  const actions = data ? actionsBlock(view, data, pos, workspaceId) : null;
  if (actions) dom.append(actions);
  return dom;
}

export function plainHoverBox(data: HoverData): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
  if (data.diagnostics.length) dom.append(diagnosticsBlock(data));
  if (data.related.length) dom.append(relatedBlock(data));
  if (data.html) {
    const block = block_("cm-hover-section");
    block.innerHTML = data.html;
    dom.append(block);
  }
  const items = [data.type ? { label: S.copyType, run: () => copyResult(data.type, "type") } : null, data.signature ? { label: S.copySignature, run: () => copyResult(data.signature, "signature") } : null].filter((item) => item !== null);
  if (items.length) {
    const block = block_("cm-hover-actions");
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-hover-action";
      button.textContent = item.label;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", item.run);
      block.append(button);
    }
    dom.append(block);
  }
  return dom;
}

const block_ = (className: string) => {
  const el = document.createElement("div");
  el.className = `cm-hover-block ${className}`;
  return el;
};

function diagnosticsBlock(data: HoverData) {
  const block = block_("cm-hover-diagnostics");
  for (const diagnostic of data.diagnostics) {
    const row = document.createElement("div");
    row.className = "cm-hover-diagnostic";
    row.append(diagnostic.message);
    const label = diagnosticLabel(diagnostic);
    if (label) {
      const code = document.createElement("span");
      code.className = "cm-hover-code";
      code.textContent = ` ${label}`;
      row.append(code);
    }
    block.append(row);
  }
  return block;
}

function relatedBlock(data: HoverData) {
  const block = block_("cm-hover-related");
  for (const item of data.related) {
    const row = document.createElement("div");
    row.className = "cm-hover-related-item";
    const link = document.createElement("button");
    link.type = "button";
    link.className = "cm-hover-action";
    link.textContent = `${item.path.slice(item.path.lastIndexOf("/") + 1)}(${item.line}, ${item.column}):`;
    link.addEventListener("mousedown", (event) => event.preventDefault());
    link.addEventListener("click", () => openRelated(item));
    row.append(link, ` ${item.message}`);
    block.append(row);
    if (item.code) {
      const pre = document.createElement("pre");
      pre.textContent = item.code;
      block.append(pre);
    }
  }
  return block;
}

function actionsBlock(view: EditorView, data: HoverData, pos: number, workspaceId: string) {
  const items: { label: string; run: () => void }[] = [];
  const problem = data.diagnostics[0];
  if (problem) items.push({ label: S.hoverViewProblem(commandKeyLabel("nextProblem")), run: () => viewProblem(view, problem) });
  if (data.hasFixes) {
    const fixKey = activeBindings().find((b) => b.command === "quickFix" && b.keys.length === 1)?.keys[0];
    items.push({ label: S.hoverQuickFix(fixKey ? strokeLabel(fixKey) : null), run: () => void openQuickFix(view, pos) });
  }
  if (problem) {
    const context = () => problemContext(view, workspaceId, problem, data.related);
    items.push({ label: S.hoverExplain(commandKeyLabel("quickAsk")), run: () => { const ctx = context(); if (ctx) explainProblem(view, ctx); } });
    items.push({ label: S.hoverFixWithClaude, run: () => { const ctx = context(); if (ctx) fixWithClaude(ctx); } });
  }
  if (data.type) items.push({ label: S.copyType, run: () => copyResult(data.type, "type") });
  if (data.signature) items.push({ label: S.copySignature, run: () => copyResult(data.signature, "signature") });
  if (!items.length) return null;
  const block = block_("cm-hover-actions");
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-hover-action";
    button.textContent = item.label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", item.run);
    block.append(button);
  }
  return block;
}

function previewBlock(view: EditorView, preview: Preview) {
  const block = block_("cm-definition-preview");
  const pre = document.createElement("pre");
  const language = preview.languageId ? highlightLanguageFor(preview.languageId) : null;
  if (language) {
    highlightCode(
      preview.text,
      language.parser.parse(preview.text),
      { style: (tags) => highlightingFor(view.state, tags) },
      (text, cls) => {
        if (!cls) return void pre.append(text);
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        pre.append(span);
      },
      () => pre.append("\n"),
    );
  } else pre.textContent = preview.text;
  block.append(pre);
  if (preview.truncated) {
    const more = document.createElement("div");
    more.className = "cm-definition-preview-more";
    more.textContent = "…";
    block.append(more);
  }
  return block;
}
