import type { PhoneElement, PhoneFrame } from "@shared/mobile";

type DomNode = {
  nodeName?: string;
  nodeType?: number;
  id?: string;
  data?: string;
  parentElement?: DomNode | null;
  childNodes?: ArrayLike<DomNode>;
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
};

type Fiber = { type?: unknown; memoizedProps?: Record<string, unknown> | null; return?: Fiber | null };

const TEXT_NODE = 3;
const MAX_TEXTS = 12;
const MAX_TEXT_LENGTH = 200;
const MAX_ANCESTORS_FOR_TEXT = 4;
const MAX_FIBER_HOPS = 80;
const MAX_COMPONENTS = 24;
const HANDLE_SYMBOL = "internalInstanceHandle";

export function describeTarget(target: unknown, tap: { x: number; y: number }): PhoneElement {
  const node = isNode(target) ? target : null;
  const fiber = node ? fiberOf(node) : null;
  return {
    tap: { x: round(tap.x), y: round(tap.y) },
    frame: node ? frameOf(node) : null,
    nodeName: node?.nodeName ?? null,
    label: fiber ? accessibilityLabel(fiber) : null,
    nativeId: node?.id ? node.id : null,
    texts: node ? nearbyTexts(node) : [],
    components: fiber ? componentChain(fiber) : [],
  };
}

export function elementTitle(element: PhoneElement | null): string {
  if (!element) return "this screen";
  const text = element.label ?? element.texts[0];
  if (text) return `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
  return "the marked spot";
}

function isNode(value: unknown): value is DomNode {
  return typeof value === "object" && value !== null && typeof (value as DomNode).getBoundingClientRect === "function";
}

function frameOf(node: DomNode): PhoneFrame | null {
  try {
    const rect = node.getBoundingClientRect?.();
    return rect ? { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) } : null;
  } catch {
    return null;
  }
}

function nearbyTexts(node: DomNode): string[] {
  let current: DomNode | null | undefined = node;
  for (let level = 0; current && level <= MAX_ANCESTORS_FOR_TEXT; level++) {
    const texts = textsUnder(current);
    if (texts.length) return texts;
    current = current.parentElement;
  }
  return [];
}

function textsUnder(root: DomNode): string[] {
  const found: string[] = [];
  const visit = (node: DomNode) => {
    if (found.length >= MAX_TEXTS) return;
    if (node.nodeType === TEXT_NODE) {
      const text = (node.data ?? "").replace(/\s+/g, " ").trim();
      if (text && !found.includes(text)) found.push(text.slice(0, MAX_TEXT_LENGTH));
      return;
    }
    const children = node.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i++) visit(children[i]);
  };
  try {
    visit(root);
  } catch {
    return found;
  }
  return found;
}

function fiberOf(node: DomNode): Fiber | null {
  const key = Object.getOwnPropertySymbols(node).find((symbol) => symbol.description === HANDLE_SYMBOL);
  const handle = key ? (node as Record<symbol, unknown>)[key] : null;
  return typeof handle === "object" && handle !== null ? handle as Fiber : null;
}

function accessibilityLabel(fiber: Fiber): string | null {
  let current: Fiber | null | undefined = fiber;
  for (let hops = 0; current && hops < MAX_FIBER_HOPS; hops++, current = current.return) {
    const label = current.memoizedProps?.accessibilityLabel;
    if (typeof label === "string" && label.trim()) return label.trim().slice(0, MAX_TEXT_LENGTH);
  }
  return null;
}

function componentChain(fiber: Fiber): string[] {
  const names: string[] = [];
  let current: Fiber | null | undefined = fiber;
  for (let hops = 0; current && hops < MAX_FIBER_HOPS && names.length < MAX_COMPONENTS; hops++, current = current.return) {
    const name = componentName(current.type);
    if (name && names[names.length - 1] !== name) names.push(name);
  }
  return names;
}

function componentName(type: unknown): string | null {
  if (typeof type === "function") return (type as { displayName?: string }).displayName ?? (type.name || null);
  if (typeof type !== "object" || type === null) return null;
  const wrapped = type as { displayName?: string; render?: unknown; type?: unknown };
  if (wrapped.displayName) return wrapped.displayName;
  return componentName(wrapped.render) ?? componentName(wrapped.type);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
