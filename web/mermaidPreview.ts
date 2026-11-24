import { renderMermaid } from "../shared/mermaid";

const MERMAID_LANGUAGE = /(?:^|\s)language-mermaid(?:\s|$)/;

export function mermaidPreviews(html: string, label: string): string {
  if (!html.includes("language-mermaid")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const code of doc.querySelectorAll("pre > code")) {
    if (!MERMAID_LANGUAGE.test(code.className)) continue;
    const svg = renderMermaid(doc, code.textContent ?? "");
    if (!svg) continue;
    const pre = code.parentElement!;
    const card = doc.createElement("div");
    card.className = "mermaid-preview";
    const head = doc.createElement("div");
    head.className = "mermaid-preview-head";
    const name = doc.createElement("span");
    name.textContent = label;
    head.append(name);
    const body = doc.createElement("div");
    body.className = "mermaid-preview-body";
    body.append(svg);
    card.append(head, body);
    pre.before(card);
    pre.classList.add("mermaid-source");
    pre.hidden = true;
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

export function addMermaidButtons(root: HTMLElement, labels: { expand: string; showCode: string; hideCode: string; copy: string; copied: string }, onExpand: (svg: SVGSVGElement) => void) {
  for (const card of root.querySelectorAll<HTMLElement>(".mermaid-preview")) {
    const head = card.querySelector(":scope > .mermaid-preview-head");
    const pre = card.nextElementSibling;
    if (!head || !(pre instanceof HTMLPreElement) || head.querySelector("button")) continue;
    const tools = document.createElement("span");
    tools.className = "mermaid-preview-tools";
    const button = (iconName: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon-button";
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.className = `codicon codicon-${iconName}`;
      b.append(icon);
      tools.append(b);
      return { b, icon };
    };
    const svg = card.querySelector<SVGSVGElement>(":scope > .mermaid-preview-body > svg");
    if (svg) {
      const expand = button("screen-full");
      expand.b.title = labels.expand;
      expand.b.setAttribute("aria-label", labels.expand);
      expand.b.addEventListener("click", () => onExpand(svg));
      const body = svg.parentElement!;
      body.title = labels.expand;
      body.addEventListener("click", () => {
        if (!window.getSelection()?.toString()) onExpand(svg);
      });
    }
    const toggle = button("code");
    const showToggle = () => {
      const text = pre.hidden ? labels.showCode : labels.hideCode;
      toggle.b.title = text;
      toggle.b.setAttribute("aria-label", text);
      toggle.b.setAttribute("aria-pressed", String(!pre.hidden));
    };
    showToggle();
    toggle.b.addEventListener("click", () => {
      pre.hidden = !pre.hidden;
      showToggle();
    });
    const copy = button("copy");
    const showCopy = (copied: boolean) => {
      copy.icon.className = copied ? "codicon codicon-check" : "codicon codicon-copy";
      copy.b.title = copied ? labels.copied : labels.copy;
      copy.b.setAttribute("aria-label", copied ? labels.copied : labels.copy);
    };
    showCopy(false);
    let timer: number | undefined;
    copy.b.addEventListener("click", () => {
      void navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? "").then(() => {
        showCopy(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => showCopy(false), 1500);
      });
    });
    head.append(tools);
  }
}
