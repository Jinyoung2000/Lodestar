import { parseSelector, resolveByChainScript } from "./pwEngine";

function snapshotMain(mode: "snapshot" | "text"): string {
  const MAX = 60_000;
  if (mode === "text") return JSON.stringify({ title: document.title, url: location.href, text: (document.body?.innerText ?? "").slice(0, MAX) });
  const w = window as unknown as { __anRefs?: Element[] };
  const refs: Element[] = (w.__anRefs = []);
  const lines: string[] = [];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=textbox],[role=combobox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const LANDMARKS: Record<string, string> = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", FORM: "form", TABLE: "table", UL: "list", OL: "list", LI: "listitem", ASIDE: "complementary", DIALOG: "dialog" };
  const clean = (text: string | null | undefined, max = 160) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getAttribute("aria-hidden") !== "true";
  };
  const nameOf = (el: Element): string => {
    const input = el as HTMLInputElement;
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(text)) return clean(text);
    }
    const direct = el.getAttribute("aria-label") ?? (el.tagName === "IMG" ? el.getAttribute("alt") : null);
    if (clean(direct)) return clean(direct);
    if (input.labels && input.labels.length) return clean(input.labels[0].textContent);
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(input.type)) return clean(input.value);
    return clean((el as HTMLElement).innerText) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("name"));
  };
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "IMG") return "img";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "INPUT") {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox" || type === "radio") return type;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    return LANDMARKS[tag] ?? "generic";
  };
  const walk = (node: Node, depth: number) => {
    if (lines.join("\n").length > MAX) return;
    if (node.nodeType === 3) {
      const text = clean(node.textContent, 200);
      if (text) lines.push(`${"  ".repeat(depth)}- text: ${JSON.stringify(text)}`);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP.has(el.tagName) || !visible(el)) return;
    const role = roleOf(el);
    const interactive = el.matches(INTERACTIVE);
    const heading = role === "heading";
    const emit = interactive || heading || role === "img" || (role !== "generic" && el.tagName in LANDMARKS);
    let next = depth;
    if (emit) {
      let line = `${"  ".repeat(depth)}- ${role}`;
      const name = nameOf(el);
      if (name) line += ` ${JSON.stringify(name)}`;
      if (heading) line += ` [level=${el.tagName.slice(1)}]`;
      if (interactive) {
        refs.push(el);
        line += ` [ref=e${refs.length}]`;
        const href = (el as HTMLAnchorElement).getAttribute("href");
        if (el.tagName === "A" && href) line += ` [href=${href.slice(0, 200)}]`;
        const input = el as HTMLInputElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          if (input.type === "checkbox" || input.type === "radio") line += input.checked ? " [checked]" : "";
          else if (input.type !== "password" && input.value) line += ` [value=${JSON.stringify(clean(input.value, 100))}]`;
        }
        if ((el as HTMLButtonElement).disabled) line += " [disabled]";
      }
      lines.push(line);
      next = depth + 1;
      if (interactive && el.tagName !== "SELECT" && !el.querySelector(INTERACTIVE) && name) return;
    }
    for (const child of Array.from(el.childNodes)) walk(child, next);
  };
  if (document.body) walk(document.body, 0);
  return JSON.stringify({ title: document.title, url: location.href, text: lines.join("\n").slice(0, MAX) });
}

function focusMain(): string {
  const el = (window as unknown as { __anTarget?: Element }).__anTarget as HTMLElement | undefined;
  if (!el) return "no target";
  el.focus();
  const field = el as HTMLInputElement;
  if (typeof field.select === "function" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) field.select();
  else if (el.isContentEditable) document.execCommand("selectAll");
  return "ok";
}

function clickMain(): string {
  const el = (window as unknown as { __anTarget?: Element }).__anTarget as HTMLElement | undefined;
  if (!el) return "no target";
  el.click();
  return "ok";
}

const call = (fn: { toString(): string }, args: unknown[] = []) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;

export const snapshotScript = (mode: "snapshot" | "text") => call(snapshotMain, [mode]);
export const resolveScript = (ref: string | null, selector: string | null): string | null => {
  if (ref) return resolveByChainScript([{ k: "ref", v: ref }]);
  if (selector) return resolveByChainScript(parseSelector(selector));
  return null;
};
export const FOCUS_SCRIPT = call(focusMain);
export const CLICK_SCRIPT = call(clickMain);
