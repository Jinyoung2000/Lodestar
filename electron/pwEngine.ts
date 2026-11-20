// 에이전트의 Browser 도구와 run_playwright_code 가 공유 페이지 안에서 요소를 찾는 엔진. 메인 프로세스가 guest 의 격리된 JS 세계(executeJavaScriptInIsolatedWorld)에서 실행한다.
// Playwright 의 선택자 일부(css, text=, role=, xpath=, aria-ref=, id=, data-testid=, `>>` 연쇄, :has-text(), :text())를 같은 뜻으로 읽는다.
// 함수들은 문자열로 바뀌어 페이지에 들어가므로 자기 안의 것만 쓴다.

export type ChainStep =
  | { k: "css"; v: string }
  | { k: "xpath"; v: string }
  | { k: "ref"; v: string }
  | { k: "text"; v: string; exact?: boolean; re?: { src: string; flags: string } }
  | { k: "role"; v: string; name?: string; nameRe?: { src: string; flags: string }; exact?: boolean }
  | { k: "label" | "placeholder" | "alt" | "title" | "testid"; v: string; exact?: boolean }
  | { k: "nth"; v: number }
  | { k: "filter"; hasText?: string; hasNotText?: string; has?: ChainStep[] };

export type LocateRequest = { chain: ChainStep[]; mode: string; arg?: unknown; timeout: number; strict: boolean };

// 요소를 찾는 도구 모음을 돌려준다. 격리된 세계의 window.__anRefs(read_page 가 붙인 ref)를 읽는다.
export function engineMain() {
  const clean = (text: string | null | undefined, max = 4000) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const refsOf = () => (window as unknown as { __anRefs?: Element[] }).__anRefs ?? [];
  const shown = (el: Element) => {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getAttribute("aria-hidden") !== "true";
  };
  const visible = (el: Element) => {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
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
  const LANDMARKS: Record<string, string> = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", FORM: "form", TABLE: "table", UL: "list", OL: "list", LI: "listitem", ASIDE: "complementary", DIALOG: "dialog" };
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
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
  const textOf = (el: Element) => clean((el as HTMLElement).innerText ?? el.textContent);
  const matchText = (text: string, want: string, exact: boolean | undefined, re?: { src: string; flags: string }) => {
    if (re) return new RegExp(re.src, re.flags).test(text);
    return exact ? text === clean(want) : text.toLowerCase().includes(clean(want).toLowerCase());
  };
  const unique = (list: Element[]) => Array.from(new Set(list));
  const all = (scope: ParentNode, selector: string): Element[] => {
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch {
      throw new Error(`Invalid selector: ${selector}`);
    }
  };

  // css 조각: :has-text("…"), :text("…"), :text-is("…"), :visible 를 읽어 걸러 낸다. 이 확장 앞뒤는 평범한 css 다.
  const PSEUDO = /:(has-text|text-is|text|visible)(?:\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')(i?)\))?/;
  const cssFind = (scope: ParentNode, selector: string): Element[] => {
    const m = PSEUDO.exec(selector);
    if (!m) return all(scope, selector);
    const left = selector.slice(0, m.index).trim() || "*";
    const right = selector.slice(m.index + m[0].length).trim();
    const want = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
    let hits = all(scope, left);
    if (m[1] === "visible") hits = hits.filter(visible);
    else if (m[1] === "has-text") hits = hits.filter((el) => textOf(el).toLowerCase().includes(clean(want).toLowerCase()));
    else if (m[1] === "text-is") hits = hits.filter((el) => textOf(el) === clean(want));
    else {
      const matches = hits.filter((el) => textOf(el).toLowerCase().includes(clean(want).toLowerCase()));
      hits = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    }
    if (!right) return hits;
    const rest = right.replace(/^>\s*/, "> ");
    return unique(hits.flatMap((el) => (rest.startsWith(">") || PSEUDO.test(rest) ? cssFind(el, rest.startsWith(">") ? `:scope ${rest}` : rest) : all(el, `:scope ${rest}`))));
  };

  const textFind = (scope: ParentNode, step: { v: string; exact?: boolean; re?: { src: string; flags: string } }): Element[] => {
    const hits = all(scope, "*").filter((el) => !["SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "META", "LINK", "TITLE"].includes(el.tagName) && matchText(textOf(el), step.v, step.exact, step.re));
    return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  };

  const find = (step: ChainStep, scope: ParentNode): Element[] => {
    switch (step.k) {
      case "css":
        return cssFind(scope, step.v);
      case "xpath": {
        const out: Element[] = [];
        const doc = scope.ownerDocument ?? (scope as Document);
        const result = doc.evaluate(step.v, scope as Node, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < result.snapshotLength; i++) {
          const node = result.snapshotItem(i);
          if (node && node.nodeType === 1) out.push(node as Element);
        }
        return out;
      }
      case "ref": {
        const index = Number(/^e(\d+)$/.exec(step.v)?.[1]) - 1;
        const el = refsOf()[index];
        return el && el.isConnected ? [el] : [];
      }
      case "text":
        return textFind(scope, step);
      case "role":
        return all(scope, "*").filter((el) => roleOf(el) === step.v && (step.name === undefined && !step.nameRe ? true : matchText(nameOf(el), step.name ?? "", step.exact, step.nameRe)));
      case "label": {
        const labels = all(scope, "label").filter((l) => matchText(textOf(l), step.v, step.exact));
        const out: Element[] = [];
        for (const label of labels) {
          const control = (label as HTMLLabelElement).control;
          if (control) out.push(control);
        }
        for (const el of all(scope, "[aria-label]")) if (matchText(clean(el.getAttribute("aria-label")), step.v, step.exact)) out.push(el);
        return unique(out);
      }
      case "placeholder":
        return all(scope, "[placeholder]").filter((el) => matchText(clean(el.getAttribute("placeholder")), step.v, step.exact));
      case "alt":
        return all(scope, "[alt]").filter((el) => matchText(clean(el.getAttribute("alt")), step.v, step.exact));
      case "title":
        return all(scope, "[title]").filter((el) => matchText(clean(el.getAttribute("title")), step.v, step.exact));
      case "testid":
        return all(scope, "[data-testid],[data-test-id],[data-test]").filter((el) => ["data-testid", "data-test-id", "data-test"].some((a) => el.getAttribute(a) === step.v));
      default:
        return [];
    }
  };

  // 연쇄를 따라 요소를 찾는다. nth 와 filter 는 지금까지 찾은 목록에 적용되고, 나머지는 각 요소 안에서 더 찾는다.
  const resolve = (chain: ChainStep[]): Element[] => {
    let els: Element[] | null = null;
    for (const step of chain) {
      if (step.k === "nth") {
        const list: Element[] = els ?? [];
        const el: Element | undefined = step.v < 0 ? list[list.length + step.v] : list[step.v];
        els = el ? [el] : [];
      } else if (step.k === "filter") {
        const list: Element[] = els ?? [];
        els = list.filter((el) => {
          if (step.hasText !== undefined && !textOf(el).toLowerCase().includes(clean(step.hasText).toLowerCase())) return false;
          if (step.hasNotText !== undefined && textOf(el).toLowerCase().includes(clean(step.hasNotText).toLowerCase())) return false;
          if (step.has && resolveIn(el, step.has).length === 0) return false;
          return true;
        });
      } else {
        const scopes: ParentNode[] = els ?? [document];
        els = unique(scopes.flatMap((scope) => find(step, scope)));
      }
    }
    return els ?? [];
  };
  const resolveIn = (scope: ParentNode, chain: ChainStep[]): Element[] => {
    let els: Element[] = [];
    chain.forEach((step, i) => {
      els = unique((i === 0 ? [scope] : els).flatMap((s) => find(step, s as ParentNode)));
    });
    return els;
  };
  return { clean, shown, visible, nameOf, roleOf, textOf, resolve, LANDMARKS };
}

// 선택 하나(ref 나 선택자)를 연쇄로. 선택자 글은 `>>` 로 이어지고, 앞에 text=, role=, xpath=, aria-ref=, id=, data-testid= 를 쓸 수 있다. 그 밖은 css 다.
export function parseSelector(input: string): ChainStep[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === ">" && input[i + 1] === ">" && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  parts.push(input.slice(start));
  const unquote = (raw: string) => {
    const t = raw.trim();
    const m = /^(["'])((?:[^\\]|\\.)*)\1(i|s)?$/.exec(t);
    if (m) return { text: m[2].replace(/\\(.)/g, "$1"), exact: true, strictCase: m[3] === "s" };
    const re = /^\/(.*)\/([a-z]*)$/.exec(t);
    if (re) return { text: "", exact: false, re: { src: re[1], flags: re[2] } };
    return { text: t, exact: false };
  };
  return parts.map((raw): ChainStep => {
    const part = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^nth=(-?\d+)$/.exec(part))) return { k: "nth", v: Number(m[1]) };
    if ((m = /^aria-ref=(.+)$/.exec(part))) return { k: "ref", v: m[1].trim() };
    if ((m = /^xpath=(.+)$/.exec(part))) return { k: "xpath", v: m[1] };
    if (part.startsWith("//") || part.startsWith("..")) return { k: "xpath", v: part };
    if ((m = /^text=(.+)$/s.exec(part))) {
      const q = unquote(m[1]);
      return { k: "text", v: q.text, exact: q.exact, ...(q.re ? { re: q.re } : {}) };
    }
    if ((m = /^role=([\w-]+)(.*)$/s.exec(part))) {
      const nameMatch = /\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\/(.*)\/([a-z]*))(i|s)?\]/.exec(m[2]);
      const step: ChainStep = { k: "role", v: m[1] };
      if (nameMatch) {
        if (nameMatch[3] !== undefined) step.nameRe = { src: nameMatch[3], flags: nameMatch[4] ?? "" };
        else step.name = (nameMatch[1] ?? nameMatch[2] ?? "").replace(/\\(.)/g, "$1");
        step.exact = nameMatch[5] === "s";
      }
      return step;
    }
    if ((m = /^id=(.+)$/.exec(part))) return { k: "css", v: `[id="${m[1].replace(/"/g, '\\"')}"]` };
    if ((m = /^data-testid=(.+)$/.exec(part))) return { k: "testid", v: unquote(m[1]).text, exact: true };
    return { k: "css", v: part };
  });
}

// 연쇄를 사람이 읽을 글로(오류 문구용)
export function describeChain(chain: ChainStep[]): string {
  const one = (s: ChainStep): string => {
    switch (s.k) {
      case "css":
        return `locator(${JSON.stringify(s.v)})`;
      case "xpath":
        return `locator("xpath=${s.v}")`;
      case "ref":
        return `locator("aria-ref=${s.v}")`;
      case "text":
        return `getByText(${JSON.stringify(s.re ? `/${s.re.src}/${s.re.flags}` : s.v)})`;
      case "role":
        return `getByRole(${JSON.stringify(s.v)}${s.name !== undefined ? `, { name: ${JSON.stringify(s.name)} }` : ""})`;
      case "nth":
        return s.v === 0 ? "first()" : s.v === -1 ? "last()" : `nth(${s.v})`;
      case "filter":
        return "filter(...)";
      default:
        return `getBy${s.k[0].toUpperCase()}${s.k.slice(1)}(${JSON.stringify(s.v)})`;
    }
  };
  return chain.map(one).join(".");
}

// 찾고, 기다리고, 한 가지를 하거나 읽는다. mode 는 아래 switch 를 본다. 결과는 {ok, value|error} JSON 글이다.
// 좌표 입력이 필요한 동작(click, hover, drag)은 요소를 화면 가운데로 스크롤하고 가운데 좌표를 돌려주며, 입력 자체는 메인 프로세스가 한다.
export async function locateMain(engineFactory: () => ReturnType<typeof engineMain>, describe: string, req: LocateRequest): Promise<string> {
  const E = engineFactory();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + Math.max(0, req.timeout);
  const states = ["attached", "detached", "visible", "hidden"];
  const waitState = req.mode === "waitFor" ? String(req.arg ?? "visible") : null;
  const noWait = ["count", "isVisible", "isHidden", "allText", "allInner"].includes(req.mode);
  const fail = (error: string) => JSON.stringify({ ok: false, error });
  for (;;) {
    let els: Element[];
    try {
      els = E.resolve(req.chain);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (waitState) {
      const done = waitState === "detached" ? els.length === 0 : waitState === "attached" ? els.length > 0 : waitState === "visible" ? els.length > 0 && E.visible(els[0]) : els.length === 0 || !E.visible(els[0]);
      if (done) return JSON.stringify({ ok: true, value: null });
      if (!states.includes(waitState)) return fail(`Unknown state: ${waitState}`);
    } else if (noWait) {
      if (req.mode === "count") return JSON.stringify({ ok: true, value: els.length });
      if (req.mode === "isVisible") return JSON.stringify({ ok: true, value: els.length > 0 && E.visible(els[0]) });
      if (req.mode === "isHidden") return JSON.stringify({ ok: true, value: els.length === 0 || !E.visible(els[0]) });
      if (req.mode === "allText") return JSON.stringify({ ok: true, value: els.map((el) => el.textContent ?? "") });
      return JSON.stringify({ ok: true, value: els.map((el) => (el as HTMLElement).innerText ?? "") });
    } else if (els.length > 0) {
      if (req.strict && els.length > 1) return fail(`Strict mode violation: ${describe} resolved to ${els.length} elements. Use a more specific selector, or .first() / .nth(i).`);
      const el = els[0] as HTMLElement;
      const actionable = ["point", "domClick", "fill", "select", "check", "focus", "scroll"].includes(req.mode);
      if (!actionable || E.visible(el) || ["domClick", "focus", "select", "scroll", "fill"].includes(req.mode)) {
        const field = el as HTMLInputElement;
        switch (req.mode) {
          case "point": {
            el.scrollIntoView({ block: "center", inline: "center" });
            const r = el.getBoundingClientRect();
            return JSON.stringify({ ok: true, value: { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, label: E.nameOf(el) || el.tagName.toLowerCase(), tag: el.tagName.toLowerCase() } });
          }
          case "domClick":
            el.click();
            return JSON.stringify({ ok: true, value: null });
          case "text":
            return JSON.stringify({ ok: true, value: el.textContent });
          case "innerText":
            return JSON.stringify({ ok: true, value: el.innerText });
          case "innerHTML":
            return JSON.stringify({ ok: true, value: el.innerHTML });
          case "attr":
            return JSON.stringify({ ok: true, value: el.getAttribute(String(req.arg)) });
          case "value":
            return JSON.stringify({ ok: true, value: field.value ?? null });
          case "checked":
            return JSON.stringify({ ok: true, value: !!field.checked });
          case "enabled":
            return JSON.stringify({ ok: true, value: !field.disabled });
          case "editable":
            return JSON.stringify({ ok: true, value: !field.disabled && !field.readOnly });
          case "box": {
            const r = el.getBoundingClientRect();
            return JSON.stringify({ ok: true, value: { x: r.left, y: r.top, width: r.width, height: r.height } });
          }
          case "waitFor":
            return JSON.stringify({ ok: true, value: null });
          case "focus":
            el.focus();
            return JSON.stringify({ ok: true, value: null });
          case "blur":
            el.blur();
            return JSON.stringify({ ok: true, value: null });
          case "scroll":
            el.scrollIntoView({ block: "center", inline: "center" });
            return JSON.stringify({ ok: true, value: null });
          case "fill": {
            const value = String(req.arg ?? "");
            el.scrollIntoView({ block: "center", inline: "center" });
            el.focus();
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
              field.select();
              if (value === "") {
                field.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return JSON.stringify({ ok: true, value: "cleared" });
              }
            } else if (el.isContentEditable) document.execCommand("selectAll");
            else return fail(`Element is not an <input>, <textarea> or [contenteditable]: ${describe}`);
            return JSON.stringify({ ok: true, value: "insert" });
          }
          case "select": {
            if (el.tagName !== "SELECT") return fail(`Element is not a <select>: ${describe}`);
            const select = el as unknown as HTMLSelectElement;
            const want = (Array.isArray(req.arg) ? req.arg : [req.arg]) as unknown[];
            const chosen: string[] = [];
            for (const option of Array.from(select.options)) {
              const hit = want.some((w) => (typeof w === "string" ? option.value === w || option.label === w || option.text === w : w && typeof w === "object" ? (w as { value?: string; label?: string; index?: number }).value === option.value || (w as { label?: string }).label === option.label || (w as { index?: number }).index === option.index : false));
              option.selected = hit;
              if (hit) chosen.push(option.value);
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return JSON.stringify({ ok: true, value: chosen });
          }
          case "check": {
            const wanted = !!req.arg;
            if (!!field.checked === wanted) return JSON.stringify({ ok: true, value: "same" });
            el.scrollIntoView({ block: "center", inline: "center" });
            const r = el.getBoundingClientRect();
            return JSON.stringify({ ok: true, value: { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height } });
          }
          case "eval": {
            const { fn, arg } = req.arg as { fn: string; arg: unknown };
            const result = await new Function(`return (${fn})`)()(el, arg);
            return JSON.stringify({ ok: true, value: result === undefined ? null : result });
          }
          default:
            return fail(`Unknown locator operation: ${req.mode}`);
        }
      }
    }
    if (Date.now() >= deadline) {
      return fail(els.length === 0 ? `Timeout ${req.timeout}ms exceeded waiting for ${describe}: no element found.` : `Timeout ${req.timeout}ms exceeded waiting for ${describe}: the element is not visible.`);
    }
    await sleep(50);
  }
}

export const locateScript = (describe: string, req: LocateRequest) => `(${locateMain.toString()})(${engineMain.toString()}, ${JSON.stringify(describe)}, ${JSON.stringify(req)})`;
// 선택자 글 하나로 요소를 하나 찾아 화면 가운데로 스크롤하고 위치를 알려 준다(기존 도구용). 찾은 요소는 window.__anTarget 에 둔다.
export const resolveByChainScript = (chain: ChainStep[]) => `(${resolveFirstMain.toString()})(${engineMain.toString()}, ${JSON.stringify(chain)})`;

function resolveFirstMain(engineFactory: () => ReturnType<typeof engineMain>, chain: ChainStep[]): string {
  const E = engineFactory();
  const w = window as unknown as { __anTarget?: Element };
  let els: Element[];
  try {
    els = E.resolve(chain);
  } catch (error) {
    return JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : String(error) });
  }
  const el = els[0];
  if (!el) return JSON.stringify({ ok: false, reason: "No element matches the selector." });
  w.__anTarget = el;
  (el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const label = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.tagName).replace(/\s+/g, " ").trim().slice(0, 80);
  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), label, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height });
}
