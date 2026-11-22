import { LSPPlugin } from "@codemirror/lsp-client";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, showTooltip } from "@codemirror/view";
import { rpc } from "./rpc";
import { fileTabKey } from "./store";
import { linkField, modifierField, setLink, setModifier, sliceDeclaration, type Link, type Preview, type Range } from "./definitionLinkState";
import { lspHover, linkTooltip } from "./hoverBox";
import { quickFix } from "./quickFix";
import { loadHoverData } from "./lspHoverData";
import { languageIdFor, toTarget, uriToPath, viewFor } from "./lsp";


type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
type Location = { uri: string; range: LspRange };
type LocationLink = { originSelectionRange?: LspRange; targetUri: string; targetRange: LspRange; targetSelectionRange: LspRange };

export function definitionLink(workspaceId: string): Extension {
  return [linkField, modifierField, quickFix(), showTooltip.compute([linkField], (state) => linkTooltip(state.field(linkField), workspaceId)), lspHover(workspaceId), Prec.highest(ViewPlugin.define((view) => new DefinitionLinkController(view, workspaceId)))];
}

class DefinitionLinkController {
  private modifier = false;
  private pointer: { x: number; y: number } | null = null;
  private requestId = 0;
  private cache = new Map<number, Link | null>();
  private cacheDoc: EditorState["doc"];

  constructor(
    private view: EditorView,
    private workspaceId: string,
  ) {
    this.cacheDoc = view.state.doc;
    view.dom.addEventListener("mousemove", this.onMouseMove);
    view.dom.addEventListener("mouseleave", this.onMouseLeave);
    view.dom.addEventListener("mousedown", this.onMouseDown, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("keyup", this.onKey, true);
    window.addEventListener("blur", this.onBlur);
  }

  update() {
    if (this.view.state.doc !== this.cacheDoc) {
      this.cacheDoc = this.view.state.doc;
      this.cache.clear();
    }
  }

  destroy() {
    this.requestId++;
    this.view.dom.removeEventListener("mousemove", this.onMouseMove);
    this.view.dom.removeEventListener("mouseleave", this.onMouseLeave);
    this.view.dom.removeEventListener("mousedown", this.onMouseDown, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("keyup", this.onKey, true);
    window.removeEventListener("blur", this.onBlur);
  }

  private onMouseMove = (event: MouseEvent) => {
    this.pointer = { x: event.clientX, y: event.clientY };
    this.setModifier(event.metaKey || event.ctrlKey);
    this.evaluate();
  };

  private setModifier(held: boolean) {
    this.modifier = held;
    if (this.view.state.field(modifierField) !== held) this.view.dispatch({ effects: setModifier.of(held) });
  }

  private onMouseLeave = () => {
    this.pointer = null;
    this.clear();
  };

  private onMouseDown = () => this.clear();

  private onKey = (event: KeyboardEvent) => {
    const next = event.metaKey || event.ctrlKey;
    if (next === this.modifier) return;
    this.setModifier(next);
    this.evaluate();
  };

  private onBlur = () => {
    this.setModifier(false);
    this.clear();
  };

  private clear() {
    this.requestId++;
    if (this.view.state.field(linkField, false)) this.view.dispatch({ effects: setLink.of(null) });
  }

  private evaluate() {
    const view = this.view;
    if (!this.modifier || !this.pointer) return this.clear();
    const hit = wordUnder(view, this.pointer);
    if (!hit) return this.clear();
    const current = view.state.field(linkField, false);
    if (current && current.from <= hit.pos && hit.pos <= current.to) return;
    const id = ++this.requestId;
    void this.resolve(hit).then((link) => {
      if (id !== this.requestId || !this.modifier) return;
      if (link && this.pointer) {
        const now = wordUnder(view, this.pointer);
        if (!now || now.pos < link.from || now.pos > link.to) return;
      }
      view.dispatch({ effects: setLink.of(link) });
    });
  }

  private async resolve(hit: { pos: number; word: Range }): Promise<Link | null> {
    const view = this.view;
    if (this.cache.has(hit.word.from)) return this.cache.get(hit.word.from) ?? null;
    const plugin = LSPPlugin.get(view);
    if (!plugin) return null;
    const doc = view.state.doc;
    let result: Location | Location[] | LocationLink[] | null;
    let hover: Link["hover"] = null;
    try {
      plugin.client.sync();
      const params = { textDocument: { uri: plugin.uri }, position: plugin.toPosition(hit.pos, doc) };
      [result, hover] = await Promise.all([
        plugin.client.request<object, Location | Location[] | LocationLink[] | null>("textDocument/definition", params),
        loadHoverData(plugin, hit.pos, this.workspaceId).catch(() => null),
      ]);
    } catch {
      return null;
    }
    const first = (Array.isArray(result) ? result : result ? [result] : [])[0];
    let link: Link | null = null;
    if (first && view.state.doc === doc) {
      const origin = "targetUri" in first ? first.originSelectionRange : undefined;
      const range = origin ? { from: plugin.fromPosition(origin.start, doc), to: plugin.fromPosition(origin.end, doc) } : hit.word;
      link = { ...range, preview: await loadPreview(first, this.workspaceId), hover };
    }
    if (view.state.doc === doc) this.cache.set(hit.word.from, link);
    return link;
  }
}

function wordUnder(view: EditorView, point: { x: number; y: number }): { pos: number; word: Range } | null {
  const pos = view.posAtCoords(point);
  if (pos == null) return null;
  const word = view.state.wordAt(pos);
  if (!word) return null;
  const start = view.coordsAtPos(word.from, 1);
  const end = view.coordsAtPos(word.to, -1);
  if (!start || !end) return null;
  if (point.y < start.top || point.y > start.bottom || point.x < start.left || point.x > end.right) return null;
  return { pos, word };
}

async function loadPreview(location: Location | LocationLink, workspaceId: string): Promise<Preview | null> {
  const uri = "targetUri" in location ? location.targetUri : location.uri;
  const range = "targetUri" in location ? location.targetRange : location.range;
  const target = toTarget(uriToPath(uri), workspaceId);
  const open = viewFor(fileTabKey(target.workspaceId, target.path));
  let lines: string[];
  try {
    lines = open ? open.state.doc.toString().split("\n") : ((await rpc.call("files.read", { workspaceId: target.workspaceId, path: target.path })).text ?? "").split("\n");
  } catch {
    return null;
  }
  return sliceDeclaration(lines, range.start.line, "targetUri" in location ? range.end.line : null, languageIdFor(target.path));
}
