const SVG_NS = "http://www.w3.org/2000/svg";

type Font = { size: number; line: number; width: (text: string) => number };

let canvas: CanvasRenderingContext2D | null | undefined;
function font(): Font | null {
  if (typeof document === "undefined") return null;
  const style = getComputedStyle(document.documentElement);
  const sizeText = style.getPropertyValue("--text-ui-sm").trim();
  const size = parseFloat(sizeText) || 12;
  const line = parseFloat(style.getPropertyValue("--leading-ui-sm")) || size * 1.5;
  if (canvas === undefined) canvas = document.createElement("canvas").getContext("2d");
  if (canvas) canvas.font = `${sizeText} ${style.getPropertyValue("--font-sans")}`;
  const width = (text: string) => (canvas ? canvas.measureText(text).width : text.length * size * 0.6);
  return { size, line, width };
}

function labelLines(raw: string): string[] {
  let text = raw.trim();
  if (/^".*"$/s.test(text)) text = text.slice(1, -1);
  if (/^`.*`$/s.test(text)) text = text.slice(1, -1);
  text = text.replace(/#quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return text.split(/<br\s*\/?>|\\n/i).map((part) => part.trim());
}

const textWidth = (f: Font, lines: string[]) => Math.max(0, ...lines.map((l) => f.width(l)));

class Svg {
  layers: Element[][] = [[], [], [], [], []];
  constructor(private doc: Document) {}
  el(layer: number, name: string, attrs: Record<string, string | number>, text?: string) {
    const node = this.doc.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    this.layers[layer]!.push(node);
    return node;
  }
  text(layer: number, f: Font, x: number, y: number, lines: string[], cls = "mm-text", anchor = "middle") {
    const top = y - (lines.length * f.line) / 2;
    lines.forEach((line, i) => this.el(layer, "text", { x, y: top + f.line * (i + 0.5), class: cls, "text-anchor": anchor, "dominant-baseline": "central" }, line));
  }
  finish(width: number, height: number, id: string, x0 = 0, y0 = 0): SVGSVGElement {
    const svg = this.doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const w = Math.ceil(width);
    const h = Math.ceil(height);
    svg.setAttribute("viewBox", `${Math.floor(x0)} ${Math.floor(y0)} ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("role", "img");
    const defs = this.doc.createElementNS(SVG_NS, "defs");
    const marker = (name: string, path: string, cls: string) => {
      const m = this.doc.createElementNS(SVG_NS, "marker");
      for (const [k, v] of Object.entries({ id: `${id}-${name}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" })) m.setAttribute(k, String(v));
      const p = this.doc.createElementNS(SVG_NS, "path");
      p.setAttribute("d", path);
      p.setAttribute("class", cls);
      m.append(p);
      defs.append(m);
    };
    marker("arrow", "M0,0 L10,5 L0,10 z", "mm-head");
    marker("open", "M0,0 L10,5 L0,10", "mm-head-open");
    marker("cross", "M1,1 L9,9 M9,1 L1,9", "mm-head-cross");
    marker("dot", "M1,5 a4,4 0 1,0 8,0 a4,4 0 1,0 -8,0", "mm-head-open");
    svg.append(defs);
    for (const layer of this.layers) svg.append(...layer);
    return svg;
  }
}

let diagramCount = 0;

type SeqArrow = { dashed: boolean; head: "arrow" | "open" | "cross" | null };
type SeqEvent =
  | { kind: "message"; from: string; to: string; arrow: SeqArrow; text: string[] }
  | { kind: "note"; place: "over" | "left" | "right"; actors: string[]; text: string[] }
  | { kind: "open"; block: string; text: string[] }
  | { kind: "divider"; text: string[] }
  | { kind: "close" };

const SEQ_MESSAGE = /^(.+?)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?\s*(.+?)\s*(?::\s*(.*))?$/;
const SEQ_BLOCK = /^(rect|alt|opt|loop|par|critical|break|box)\b\s*(.*)$/;

function parseSequence(lines: string[]) {
  const actors: { id: string; label: string[] }[] = [];
  const byId = new Map<string, number>();
  const actor = (id: string, label?: string) => {
    const key = id.trim();
    const known = byId.get(key);
    if (known !== undefined) {
      if (label) actors[known]!.label = labelLines(label);
      return;
    }
    byId.set(key, actors.length);
    actors.push({ id: key, label: labelLines(label ?? key) });
  };
  const events: SeqEvent[] = [];
  let numbered = false;
  let count = 0;
  for (const line of lines) {
    if (/^(activate|deactivate|title|accTitle|accDescr|links?|properties|details)\b/.test(line)) continue;
    if (line === "autonumber" || line.startsWith("autonumber ")) {
      numbered = true;
      continue;
    }
    const decl = /^(?:create\s+)?(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(line);
    if (decl) {
      actor(decl[1]!.replace(/^"(.*)"$/, "$1"), decl[2]);
      continue;
    }
    if (/^destroy\s/.test(line)) continue;
    const note = /^note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line);
    if (note) {
      const ids = note[2]!.split(",").map((s) => s.trim()).filter(Boolean);
      ids.forEach((id) => actor(id));
      const place = note[1]!.toLowerCase().startsWith("left") ? "left" : note[1]!.toLowerCase().startsWith("right") ? "right" : "over";
      events.push({ kind: "note", place, actors: ids, text: labelLines(note[3]!) });
      continue;
    }
    const block = SEQ_BLOCK.exec(line);
    if (block) {
      events.push({ kind: "open", block: block[1]!, text: block[1] === "rect" || block[1] === "box" ? [] : labelLines(block[2]!) });
      continue;
    }
    const divider = /^(else|and|option)\b\s*(.*)$/.exec(line);
    if (divider) {
      events.push({ kind: "divider", text: labelLines(divider[2]!) });
      continue;
    }
    if (line === "end") {
      events.push({ kind: "close" });
      continue;
    }
    const message = SEQ_MESSAGE.exec(line);
    if (message) {
      const [, from, op, to, text] = message;
      actor(from!);
      actor(to!);
      const head = op!.endsWith(">>") ? "arrow" : op!.endsWith("x") ? "cross" : op!.endsWith(")") ? "open" : null;
      const label = labelLines(text ?? "");
      if (numbered) label[0] = `${++count}. ${label[0]}`;
      events.push({ kind: "message", from: from!.trim(), to: to!.trim(), arrow: { dashed: op!.startsWith("--"), head }, text: label });
      continue;
    }
    return null;
  }
  return actors.length ? { actors, byId, events } : null;
}

function renderSequence(doc: Document, lines: string[], f: Font): SVGSVGElement | null {
  const parsed = parseSequence(lines);
  if (!parsed) return null;
  const { actors, byId, events } = parsed;
  const PAD_X = 12;
  const PAD_Y = 6;
  const MARGIN = 8;
  const boxW = actors.map((a) => Math.max(textWidth(f, a.label) + PAD_X * 2, 64));
  const boxH = Math.max(...actors.map((a) => a.label.length)) * f.line + PAD_Y * 2;
  const gaps = actors.slice(1).map((_, i) => (boxW[i]! + boxW[i + 1]!) / 2 + 32);
  const need = (a: number, b: number, width: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let have = 0;
    for (let i = lo; i < hi; i++) have += gaps[i]!;
    if (have < width) gaps[hi - 1]! += width - have;
  };
  let rightExtra = 0;
  let leftExtra = 0;
  for (const event of events) {
    if (event.kind === "message") {
      const a = byId.get(event.from)!;
      const b = byId.get(event.to)!;
      const w = textWidth(f, event.text) + 24;
      if (a === b) {
        if (a < actors.length - 1) need(a, a + 1, w + 40);
        else if (a > 0) need(a - 1, a, w + 40);
        else rightExtra = Math.max(rightExtra, w + 40);
      } else need(a, b, w);
    } else if (event.kind === "note") {
      const idx = event.actors.map((id) => byId.get(id)!);
      const w = textWidth(f, event.text) + PAD_X * 2;
      if (event.place === "over" && idx.length > 1) need(Math.min(...idx), Math.max(...idx), w - 24);
      else if (event.place === "right") {
        const i = idx[0]!;
        if (i < actors.length - 1) need(i, i + 1, w + 16);
        else rightExtra = Math.max(rightExtra, w + 16);
      } else if (event.place === "left") {
        const i = idx[0]!;
        if (i > 0) need(i - 1, i, w + 16);
        else leftExtra = Math.max(leftExtra, w + 16 - boxW[0]! / 2);
      } else {
        const i = idx[0]!;
        const half = w / 2;
        if (i > 0) need(i - 1, i, half + boxW[i - 1]! / 2);
        if (i < actors.length - 1) need(i, i + 1, half + boxW[i + 1]! / 2);
        if (i === 0) leftExtra = Math.max(leftExtra, half - boxW[0]! / 2);
        if (i === actors.length - 1) rightExtra = Math.max(rightExtra, half - boxW[i]! / 2);
      }
    }
  }
  const blockDepth = Math.min(4, events.filter((e) => e.kind === "open").length);
  const frameRoom = blockDepth ? 16 : 0;
  const cx: number[] = [];
  let x = MARGIN + Math.max(leftExtra, frameRoom) + boxW[0]! / 2;
  actors.forEach((_, i) => {
    if (i > 0) x += gaps[i - 1]!;
    cx.push(x);
  });
  const width = cx[cx.length - 1]! + boxW[boxW.length - 1]! / 2 + Math.max(rightExtra, frameRoom) + MARGIN;

  const svg = new Svg(doc);
  const id = `mm${++diagramCount}`;
  let y = MARGIN + boxH + 16;
  type Open = { block: string; text: string[]; top: number; lo: number; hi: number; dividers: { y: number; text: string[] }[] };
  const stack: Open[] = [];
  const touch = (...idx: number[]) => {
    for (const open of stack) {
      open.lo = Math.min(open.lo, ...idx);
      open.hi = Math.max(open.hi, ...idx);
    }
  };
  for (const event of events) {
    if (event.kind === "message") {
      const a = byId.get(event.from)!;
      const b = byId.get(event.to)!;
      touch(a, b);
      const textH = event.text.length * f.line;
      const cls = `mm-line${event.arrow.dashed ? " mm-dashed" : ""}`;
      const end: Record<string, string> = event.arrow.head ? { "marker-end": `url(#${id}-${event.arrow.head})` } : {};
      if (a === b) {
        const left = a > 0 && a === actors.length - 1;
        svg.text(3, f, cx[a]! + (left ? -12 : 12), y + textH / 2, event.text, "mm-text", left ? "end" : "start");
        y += textH + 4;
        svg.el(2, "path", { d: left ? `M${cx[a]},${y} h-32 v20 h32` : `M${cx[a]},${y} h32 v20 h-32`, class: cls, fill: "none", ...end });
        y += 20 + 16;
      } else {
        svg.text(3, f, (cx[a]! + cx[b]!) / 2, y + textH / 2, event.text);
        y += textH + 4;
        svg.el(2, "line", { x1: cx[a]!, y1: y, x2: cx[b]!, y2: y, class: cls, ...end });
        y += 16;
      }
    } else if (event.kind === "note") {
      const idx = event.actors.map((name) => byId.get(name)!);
      touch(...idx);
      const w = textWidth(f, event.text) + PAD_X * 2;
      const h = event.text.length * f.line + PAD_Y * 2;
      let left: number;
      let right: number;
      if (event.place === "left") (right = cx[idx[0]!]! - 8), (left = right - w);
      else if (event.place === "right") (left = cx[idx[0]!]! + 8), (right = left + w);
      else {
        const lo = cx[Math.min(...idx)]! - 24;
        const hi = cx[Math.max(...idx)]! + 24;
        const span = Math.max(hi - lo, w);
        left = (lo + hi) / 2 - span / 2;
        right = left + span;
      }
      svg.el(3, "rect", { x: left, y, width: right - left, height: h, rx: 4, class: "mm-note" });
      svg.text(3, f, (left + right) / 2, y + h / 2, event.text);
      y += h + 12;
    } else if (event.kind === "open") {
      const head = event.block === "rect" || event.block === "box" ? 4 : f.line + 8;
      stack.push({ block: event.block, text: event.text, top: y, lo: Infinity, hi: -Infinity, dividers: [] });
      y += head;
    } else if (event.kind === "divider") {
      const open = stack[stack.length - 1];
      if (!open) continue;
      open.dividers.push({ y, text: event.text });
      y += f.line + 8;
    } else {
      const open = stack.pop();
      if (!open) continue;
      if (open.block === "box") continue;
      const depth = stack.length;
      const inset = Math.max(4, 16 - depth * 4);
      const lo = Number.isFinite(open.lo) ? open.lo : 0;
      const hi = Number.isFinite(open.hi) ? open.hi : actors.length - 1;
      const left = cx[lo]! - boxW[lo]! / 2 - inset + 8;
      const right = cx[hi]! + boxW[hi]! / 2 + inset - 8;
      const bottom = y + 4;
      if (open.block === "rect") {
        svg.el(0, "rect", { x: left, y: open.top, width: right - left, height: bottom - open.top, rx: 4, class: "mm-rect" });
      } else {
        svg.el(1, "rect", { x: left, y: open.top, width: right - left, height: bottom - open.top, rx: 4, class: "mm-frame" });
        const tagW = f.width(open.block) + 16;
        svg.el(1, "path", { d: `M${left},${open.top + f.line + 4} H${left + tagW - 6} L${left + tagW},${open.top + f.line - 2} V${open.top}`, class: "mm-frame" });
        svg.text(1, f, left + 8, open.top + (f.line + 4) / 2, [open.block], "mm-text mm-tag", "start");
        if (open.text.join("")) svg.text(1, f, left + tagW + 8, open.top + (f.line + 4) / 2, [`[${open.text.join(" ")}]`], "mm-text mm-muted", "start");
        for (const divider of open.dividers) {
          svg.el(1, "line", { x1: left, y1: divider.y, x2: right, y2: divider.y, class: "mm-frame mm-dashed" });
          if (divider.text.join("")) svg.text(1, f, (left + right) / 2, divider.y + (f.line + 8) / 2, [`[${divider.text.join(" ")}]`], "mm-text mm-muted");
        }
      }
      y = bottom + 12;
    }
  }
  y += 4;
  const top = MARGIN;
  actors.forEach((a, i) => {
    svg.el(0, "line", { x1: cx[i]!, y1: top + boxH, x2: cx[i]!, y2: y, class: "mm-lifeline" });
    for (const boxY of [top, y]) {
      svg.el(4, "rect", { x: cx[i]! - boxW[i]! / 2, y: boxY, width: boxW[i]!, height: boxH, rx: 4, class: "mm-node" });
      svg.text(4, f, cx[i]!, boxY + boxH / 2, a.label);
    }
  });
  return svg.finish(width, y + boxH + MARGIN, id);
}

type Shape = "rect" | "round" | "stadium" | "circle" | "diamond" | "hexagon";
type FlowNode = { id: string; text: string[]; shape: Shape; order: number; group: string | null };
type FlowHead = "arrow" | "cross" | "dot" | null;
type FlowEdge = { from: string; to: string; text: string[]; dashed: boolean; thick: boolean; head: FlowHead; tail: boolean };
type FlowGroup = { id: string; title: string[]; parent: string | null };

const SHAPES: [string, string, Shape][] = [
  ["(((", ")))", "circle"],
  ["((", "))", "circle"],
  ["([", "])", "stadium"],
  ["[[", "]]", "rect"],
  ["[(", ")]", "round"],
  ["{{", "}}", "hexagon"],
  ["[/", "/]", "rect"],
  ["[\\", "\\]", "rect"],
  ["[/", "\\]", "rect"],
  ["[\\", "/]", "rect"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "rect"],
];
const NODE_ID = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*?(?=$|[\s[\](){}>&:;|]|-[-.>xo=]|==|-\.)/u;
const EDGE_TEXT = /^\s*(<)?(--|==|-\.)(?![->=.])\s*(.+?)\s*(-{2,}>|={2,}>|\.-+>|-{2,}[xo](?![\p{L}\p{N}_])|={2,}[xo](?![\p{L}\p{N}_])|\.-+[xo](?![\p{L}\p{N}_])|-{3,}|={3,}|\.-+)/u;
const EDGE = /^\s*(<)?(-{2,}>|={2,}>|-\.+-+>|-\.+-+[xo](?![\p{L}\p{N}_])|-{2,}[xo](?![\p{L}\p{N}_])|={2,}[xo](?![\p{L}\p{N}_])|-{3,}|={3,}|-\.+-+)\s*(?:\|([^|]*)\|)?/u;
const SUBGRAPH = /^subgraph\s+(?:"([^"]*)"|([^\s[]+)\s*(?:\[\s*(?:"([^"]*)"|([^\]]*))\s*\])?\s*(.*))$/;

const flowHead = (op: string): FlowHead => (op.endsWith(">") ? "arrow" : op.endsWith("x") ? "cross" : op.endsWith("o") ? "dot" : null);

function parseFlow(lines: string[]) {
  const header = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*;?$/i.exec(lines[0]!);
  if (!header) return null;
  const dir = (header[1] ?? "TD").toUpperCase();
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const groups = new Map<string, FlowGroup>();
  const open: string[] = [];
  const node = (id: string, text?: string, shape?: Shape) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, text: labelLines(id), shape: "rect", order: nodes.size, group: null }));
    if (text !== undefined) n.text = labelLines(text);
    if (shape) n.shape = shape;
    if (n.group === null && open.length) n.group = open[open.length - 1]!;
    return n;
  };
  const readNode = (s: string): [string, string] | null => {
    const m = NODE_ID.exec(s);
    if (!m) return null;
    const id = m[0];
    let rest = s.slice(id.length);
    let text: string | undefined;
    let shape: Shape | undefined;
    for (const [openMark, close, kind] of SHAPES) {
      if (!rest.startsWith(openMark)) continue;
      let body = rest.slice(openMark.length);
      let end: number;
      if (body.startsWith("\"")) {
        const q = body.indexOf("\"", 1);
        if (q < 0) return null;
        end = body.indexOf(close, q + 1);
      } else end = body.indexOf(close);
      if (end < 0) continue;
      text = body.slice(0, end);
      body = body.slice(end + close.length);
      rest = body;
      shape = kind;
      break;
    }
    rest = rest.replace(/^:::[\w-]+/, "");
    node(id, text, shape);
    return [id, rest];
  };
  const readGroup = (s: string): [string[], string] | null => {
    const ids: string[] = [];
    let rest = s;
    for (;;) {
      const r = readNode(rest.trimStart());
      if (!r) return null;
      ids.push(r[0]);
      rest = r[1];
      const amp = /^\s*&\s*/.exec(rest);
      if (!amp) return [ids, rest];
      rest = rest.slice(amp[0].length);
    }
  };
  for (const raw of lines.slice(1)) {
    for (const statement of raw.split(/;\s*(?=\S|$)/)) {
      const line = statement.trim();
      if (!line) continue;
      const sub = SUBGRAPH.exec(line);
      if (sub) {
        const quoted = sub[1];
        const id = quoted ?? sub[2]!;
        const title = quoted ?? sub[3] ?? sub[4] ?? [sub[2], sub[5]].filter(Boolean).join(" ");
        const key = groups.has(id) ? `${id}#${groups.size}` : id;
        groups.set(key, { id: key, title: labelLines(title), parent: open[open.length - 1] ?? null });
        open.push(key);
        continue;
      }
      if (line === "end") {
        open.pop();
        continue;
      }
      if (/^(classDef|class\s|style|linkStyle|click|direction)\b/.test(line)) continue;
      const first = readGroup(line);
      if (!first) return null;
      let [from, rest] = first;
      while (rest.trim()) {
        const withText = EDGE_TEXT.exec(rest);
        const m = withText ?? EDGE.exec(rest);
        if (!m) return null;
        const op = withText ? `${m[2]}${m[4]}` : m[2]!;
        const text = m[3] ?? "";
        rest = rest.slice(m[0].length);
        const next = readGroup(rest);
        if (!next) return null;
        const [to, after] = next;
        for (const a of from) for (const b of to) {
          edges.push({ from: a, to: b, text: text ? labelLines(text) : [], dashed: op.includes("."), thick: op.includes("="), head: flowHead(op), tail: m[1] === "<" });
        }
        from = to;
        rest = after;
      }
    }
  }
  for (const id of groups.keys()) nodes.delete(id);
  const list = [...nodes.values()];
  list.forEach((n, i) => (n.order = i));
  return list.length ? { dir, nodes: list, edges, groups: [...groups.values()] } : null;
}

function renderFlow(doc: Document, lines: string[], f: Font): SVGSVGElement | null {
  const parsed = parseFlow(lines);
  if (!parsed) return null;
  const { dir, nodes, edges, groups } = parsed;
  const vertical = dir === "TD" || dir === "TB" || dir === "BT";
  const reverse = dir === "BT" || dir === "RL";
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const chain = (group: string | null) => {
    const ids: string[] = [];
    for (let g = group; g; g = groupById.get(g)?.parent ?? null) ids.unshift(g);
    return ids;
  };
  const path = nodes.map((n) => chain(n.group));
  const members = new Map(groups.map((g) => [g.id, nodes.flatMap((_, v) => (path[v]!.includes(g.id) ? [v] : []))]));
  const ends = (id: string) => {
    const v = index.get(id);
    return v !== undefined ? [v] : members.get(id) ?? [];
  };

  const out = nodes.map(() => [] as number[]);
  const incoming = nodes.map(() => [] as number[]);
  for (const e of edges) for (const a of ends(e.from)) for (const b of ends(e.to)) {
    if (a === b) continue;
    out[a]!.push(b);
    incoming[b]!.push(a);
  }

  const state = nodes.map(() => 0);
  const back = new Set<string>();
  const post: number[] = [];
  const visit = (v: number) => {
    state[v] = 1;
    for (const w of out[v]!) {
      if (state[w] === 1) back.add(`${v}>${w}`);
      else if (state[w] === 0) visit(w);
    }
    state[v] = 2;
    post.push(v);
  };
  nodes.forEach((_, v) => state[v] === 0 && visit(v));
  const rank = nodes.map(() => 0);
  for (const v of post.reverse()) for (const w of out[v]!) if (!back.has(`${v}>${w}`)) rank[w] = Math.max(rank[w]!, rank[v]! + 1);

  const ranks: number[][] = [];
  rank.forEach((r, v) => (ranks[r] ??= []).push(v));
  for (let r = 0; r < ranks.length; r++) ranks[r] ??= [];
  const pos = nodes.map(() => 0);
  const place = () => ranks.forEach((row) => row.forEach((v, i) => (pos[v] = i)));
  const cluster = (items: number[], depth: number): number[] => {
    const buckets = new Map<string, number[]>();
    for (const v of items) {
      const key = path[v]![depth] ? `g:${path[v]![depth]}` : `n:${v}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(v);
      else buckets.set(key, [v]);
    }
    return [...buckets.entries()]
      .map(([key, vs]) => ({ key, vs, at: vs.reduce((s, v) => s + pos[v]!, 0) / vs.length }))
      .sort((a, b) => a.at - b.at)
      .flatMap((b) => (b.key.startsWith("g:") ? cluster(b.vs, depth + 1) : b.vs));
  };
  const sweep = (r: number, neighbors: (v: number) => number[]) => {
    const row = ranks[r]!;
    const key = new Map(row.map((v) => {
      const near = neighbors(v);
      return [v, near.length ? near.reduce((s, w) => s + pos[w]!, 0) / near.length : pos[v]!];
    }));
    row.sort((a, b) => key.get(a)! - key.get(b)! || nodes[a]!.order - nodes[b]!.order);
    row.forEach((v, i) => (pos[v] = i));
    if (groups.length) ranks[r] = cluster(row, 0);
    place();
  };
  place();
  if (groups.length) ranks.forEach((row, r) => (ranks[r] = cluster(row, 0)));
  place();
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r < ranks.length; r++) sweep(r, (v) => incoming[v]!);
    for (let r = ranks.length - 2; r >= 0; r--) sweep(r, (v) => out[v]!);
  }

  const PAD_X = 16;
  const PAD_Y = 8;
  const size = nodes.map((n) => {
    const tw = textWidth(f, n.text);
    const th = n.text.length * f.line;
    if (n.shape === "circle") {
      const d = Math.max(tw, th) + PAD_Y * 2 + 8;
      return { w: d, h: d };
    }
    if (n.shape === "diamond") return { w: tw * 1.5 + PAD_X * 2, h: th * 1.5 + PAD_Y * 3 };
    return { w: Math.max(tw + PAD_X * 2, 48), h: th + PAD_Y * 2 };
  });
  const along = (v: number) => (vertical ? size[v]!.h : size[v]!.w);
  const across = (v: number) => (vertical ? size[v]!.w : size[v]!.h);
  const GROUP_PAD = 12;
  const TITLE = f.line + 8;
  const depthOf = (g: string): number => Math.max(0, ...groups.filter((c) => c.parent === g).map((c) => depthOf(c.id) + 1));
  const inset = (g: string) => GROUP_PAD * (depthOf(g) + 1) + (groups.some((c) => c.parent === g) ? TITLE * depthOf(g) : 0);
  const unshared = (v: number, w: number) => {
    let k = 0;
    while (k < path[v]!.length && path[v]![k] === path[w]![k]) k++;
    return path[v]!.slice(k);
  };
  const wall = (ids: string[]) => (ids.length ? inset(ids[0]!) + (vertical ? 0 : TITLE) : 0);
  const NODE_GAP = vertical ? 24 : 16;
  const labelRoom = edges.reduce((m, e) => Math.max(m, e.text.length ? (vertical ? e.text.length * f.line : textWidth(f, e.text)) + 16 : 0), 0);
  const RANK_GAP = Math.max(40, labelRoom + 24);
  const MARGIN = 8;
  const span = new Map(groups.map((g) => {
    const rs = members.get(g.id)!.map((v) => rank[v]!);
    return [g.id, { lo: Math.min(...rs), hi: Math.max(...rs) }];
  }));
  const titleAt = (side: "lo" | "hi") => (vertical && (side === "hi") === reverse ? TITLE : 0);
  const rankGap = (r: number) => {
    let after = 0;
    let before = 0;
    for (const g of groups) {
      const s = span.get(g.id)!;
      if (s.hi === r) after = Math.max(after, inset(g.id) + titleAt("hi"));
      if (s.lo === r + 1) before = Math.max(before, inset(g.id) + titleAt("lo"));
    }
    return RANK_GAP + after + before;
  };

  const gapAfter = (row: number[], i: number) => NODE_GAP + wall(unshared(row[i]!, row[i + 1]!)) + wall(unshared(row[i + 1]!, row[i]!));
  const rankSize = ranks.map((row) => Math.max(0, ...row.map(along)));
  const rowSpan = ranks.map((row) => row.reduce((s, v, i) => s + across(v) + (i < row.length - 1 ? gapAfter(row, i) : 0), 0));
  const spanMax = Math.max(...rowSpan);
  const hasBack = back.size > 0;
  const sideRoom = hasBack ? 32 : 0;
  const center = nodes.map(() => ({ a: 0, c: 0 }));
  let cursor = MARGIN;
  ranks.forEach((row, r) => {
    let c = MARGIN + (spanMax - rowSpan[r]!) / 2;
    row.forEach((v, i) => {
      center[v] = { a: cursor + rankSize[r]! / 2, c: c + across(v) / 2 };
      c += across(v) + (i < row.length - 1 ? gapAfter(row, i) : 0);
    });
    cursor += rankSize[r]! + (r < ranks.length - 1 ? rankGap(r) : 0);
  });
  const totalAlong = cursor + MARGIN;
  const totalAcross = spanMax + MARGIN * 2 + sideRoom;
  const point = (a: number, c: number) => {
    const aa = reverse ? totalAlong - a : a;
    return vertical ? { x: c, y: aa } : { x: aa, y: c };
  };

  type Box = { a0: number; a1: number; c0: number; c1: number };
  const boxes = new Map<string, Box>();
  for (const g of groups) {
    const vs = members.get(g.id)!;
    if (!vs.length) continue;
    const pad = inset(g.id);
    const box: Box = {
      a0: Math.min(...vs.map((v) => center[v]!.a - along(v) / 2)) - pad,
      a1: Math.max(...vs.map((v) => center[v]!.a + along(v) / 2)) + pad,
      c0: Math.min(...vs.map((v) => center[v]!.c - across(v) / 2)) - pad,
      c1: Math.max(...vs.map((v) => center[v]!.c + across(v) / 2)) + pad,
    };
    if (!vertical) box.c0 -= TITLE;
    else if (reverse) box.a1 += TITLE;
    else box.a0 -= TITLE;
    const titleW = textWidth(f, g.title) + GROUP_PAD * 2;
    const spanAcross = vertical ? box.c1 - box.c0 : box.a1 - box.a0;
    if (spanAcross < titleW) {
      const grow = (titleW - spanAcross) / 2;
      if (vertical) (box.c0 -= grow), (box.c1 += grow);
      else (box.a0 -= grow), (box.a1 += grow);
    }
    boxes.set(g.id, box);
  }

  type End = { a: number; c: number; al: number; ac: number; rank: number };
  const endOf = (id: string, source: boolean): End | null => {
    const v = index.get(id);
    if (v !== undefined) return { a: center[v]!.a, c: center[v]!.c, al: along(v), ac: across(v), rank: rank[v]! };
    const box = boxes.get(id);
    const vs = members.get(id);
    if (!box || !vs?.length) return null;
    const ranksIn = vs.map((w) => rank[w]!);
    return { a: (box.a0 + box.a1) / 2, c: (box.c0 + box.c1) / 2, al: box.a1 - box.a0, ac: box.c1 - box.c0, rank: source ? Math.max(...ranksIn) : Math.min(...ranksIn) };
  };

  const svg = new Svg(doc);
  const id = `mm${++diagramCount}`;
  let minX = 0;
  let minY = 0;
  const outerC = Math.max(spanMax + MARGIN, ...[...boxes.values()].map((b) => b.c1));
  const acrossEnd = Math.max(totalAcross, outerC + sideRoom + MARGIN);
  let maxX = vertical ? acrossEnd : totalAlong;
  let maxY = vertical ? totalAlong : acrossEnd;
  const depthIn = (g: FlowGroup) => chain(g.id).length;
  for (const g of [...groups].sort((a, b) => depthIn(a) - depthIn(b))) {
    const box = boxes.get(g.id);
    if (!box) continue;
    const p0 = point(box.a0, box.c0);
    const p1 = point(box.a1, box.c1);
    const x = Math.min(p0.x, p1.x);
    const y = Math.min(p0.y, p1.y);
    const w = Math.abs(p1.x - p0.x);
    const h = Math.abs(p1.y - p0.y);
    minX = Math.min(minX, x - MARGIN);
    minY = Math.min(minY, y - MARGIN);
    maxX = Math.max(maxX, x + w + MARGIN);
    maxY = Math.max(maxY, y + h + MARGIN);
    svg.el(0, "rect", { x, y, width: w, height: h, rx: 8, class: "mm-group" });
    if (g.title.join("")) svg.text(0, f, x + w / 2, y + TITLE / 2 + 2, g.title, "mm-text mm-muted");
  }

  for (const e of edges) {
    const from = endOf(e.from, true);
    const to = endOf(e.to, false);
    if (!from || !to || e.from === e.to) continue;
    const cls = `mm-line${e.dashed ? " mm-dashed" : ""}${e.thick ? " mm-thick" : ""}`;
    const marks: Record<string, string> = {};
    if (e.head) marks["marker-end"] = `url(#${id}-${e.head === "arrow" ? "arrow" : e.head})`;
    if (e.tail) marks["marker-start"] = `url(#${id}-arrow)`;
    let d: string;
    let mid: { x: number; y: number };
    if (to.rank > from.rank) {
      const s = point(from.a + from.al / 2, from.c);
      const t = point(to.a - to.al / 2, to.c);
      const m1 = point((from.a + from.al / 2 + to.a - to.al / 2) / 2, from.c);
      const m2 = point((from.a + from.al / 2 + to.a - to.al / 2) / 2, to.c);
      d = `M${s.x},${s.y} C${m1.x},${m1.y} ${m2.x},${m2.y} ${t.x},${t.y}`;
      mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
    } else if (to.rank === from.rank) {
      const left = from.c < to.c;
      const s = point(from.a, from.c + (left ? 1 : -1) * from.ac / 2);
      const t = point(to.a, to.c - (left ? 1 : -1) * to.ac / 2);
      d = `M${s.x},${s.y} L${t.x},${t.y}`;
      mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
    } else {
      const edge = outerC + sideRoom / 2;
      const s = point(from.a, from.c + from.ac / 2);
      const t = point(to.a, to.c + to.ac / 2);
      const bendS = point(from.a, edge);
      const bendT = point(to.a, edge);
      d = `M${s.x},${s.y} C${bendS.x},${bendS.y} ${bendT.x},${bendT.y} ${t.x},${t.y}`;
      mid = point((from.a + to.a) / 2, edge - sideRoom / 4);
    }
    svg.el(1, "path", { d, class: cls, fill: "none", ...marks });
    if (e.text.length) {
      const w = textWidth(f, e.text) + 8;
      const h = e.text.length * f.line + 2;
      svg.el(2, "rect", { x: mid.x - w / 2, y: mid.y - h / 2, width: w, height: h, rx: 3, class: "mm-label-bg" });
      svg.text(2, f, mid.x, mid.y, e.text, "mm-text mm-muted");
    }
  }
  nodes.forEach((n, v) => {
    const c = point(center[v]!.a, center[v]!.c);
    const { w, h } = size[v]!;
    if (n.shape === "diamond") svg.el(3, "polygon", { points: `${c.x},${c.y - h / 2} ${c.x + w / 2},${c.y} ${c.x},${c.y + h / 2} ${c.x - w / 2},${c.y}`, class: "mm-node" });
    else if (n.shape === "circle") svg.el(3, "circle", { cx: c.x, cy: c.y, r: w / 2, class: "mm-node" });
    else if (n.shape === "hexagon") {
      const k = h / 2;
      svg.el(3, "polygon", { points: `${c.x - w / 2},${c.y} ${c.x - w / 2 + k},${c.y - h / 2} ${c.x + w / 2 - k},${c.y - h / 2} ${c.x + w / 2},${c.y} ${c.x + w / 2 - k},${c.y + h / 2} ${c.x - w / 2 + k},${c.y + h / 2}`, class: "mm-node" });
    } else svg.el(3, "rect", { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h, rx: n.shape === "stadium" ? h / 2 : n.shape === "round" ? 8 : 4, class: "mm-node" });
    svg.text(4, f, c.x, c.y, n.text);
  });
  return svg.finish(maxX - minX, maxY - minY, id, minX, minY);
}

export function renderMermaid(doc: Document, source: string): SVGSVGElement | null {
  const f = font();
  if (!f) return null;
  const lines = source
    .split("\n")
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter(Boolean);
  if (!lines.length) return null;
  try {
    if (lines[0] === "sequenceDiagram") return renderSequence(doc, lines.slice(1), f);
    if (/^(flowchart|graph)\b/i.test(lines[0]!)) return renderFlow(doc, lines, f);
  } catch {
    return null;
  }
  return null;
}

