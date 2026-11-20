// Browser 탭 안의 페이지에서 요소를 고르거나(Add Element), 요소에 댓글을 달거나(Comment on Elements), 영역을 고르는(Add Area Screenshot) 스크립트. 메인 프로세스가 guest 의 격리된 JS 세계(executeJavaScriptInIsolatedWorld)에서 실행한다.
// 격리된 세계라서 페이지의 스크립트가 이 스크립트의 변수나 결과를 읽거나 바꿀 수 없다. 페이지로 가는 통로(preload, 브릿지)는 만들지 않는다.
// 이 파일의 함수들은 문자열로 바뀌어 페이지에 들어가므로 자기 안의 것만 쓴다. DOM 형태만 읽어서 단위 시험이 가짜 요소로도 부른다.

type El = { nodeType: number; tagName: string; id?: string; classList?: ArrayLike<string>; parentElement: El | null; children: ArrayLike<El> };
type Doc = { querySelectorAll(selector: string): ArrayLike<unknown> };

// 요소까지의 CSS 선택자. 고유한 id 를 만나면 거기서 끝내고, 아니면 태그와 클래스 둘, 같은 태그 형제가 있으면 :nth-of-type 을 붙여 body 까지 잇는다.
export function cssPathOf(el: El, doc: Doc): string {
  const parts: string[] = [];
  for (let node: El | null = el; node && node.nodeType === 1; node = node.parentElement) {
    const tag = String(node.tagName).toLowerCase();
    if (tag === "html") break;
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && doc.querySelectorAll(`#${node.id}`).length === 1) {
      parts.unshift(`#${node.id}`);
      break;
    }
    let part = tag;
    const classes = Array.from(node.classList ?? [])
      .filter((c) => /^[A-Za-z_][\w-]*$/.test(c))
      .slice(0, 2);
    if (classes.length) part += `.${classes.join(".")}`;
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (tag === "body") break;
  }
  return parts.join(" > ");
}

export type PickTheme = { focus: string; buttonBg: string; buttonFg: string; widgetBg: string; widgetFg: string; widgetBorder: string; widgetShadow: string; placeholder: string; hover: string; font: string };

const PICK_CSS = `
:host { all: initial; font-family: var(--pick-font); pointer-events: none !important; }
.overlay { position: fixed; inset: 0; background: transparent; box-sizing: border-box; z-index: 2; }
.comment-backdrop { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; }
.comment-backdrop-fill { fill: var(--widget-shadow); opacity: 0; transition: opacity 120ms linear; }
.comment-backdrop.visible .comment-backdrop-fill { opacity: 1; }
.highlight-shape { fill: color-mix(in srgb, var(--focus) 12%, transparent); stroke: var(--focus); stroke-width: 2px; }
.comment-layer { position: absolute; inset: 0; pointer-events: none; }
.comment-surface { position: fixed; box-sizing: border-box; width: min(320px, calc(100vw - 16px)); border: 1px solid var(--widget-border); border-radius: 8px; background: var(--widget-bg); color: var(--widget-fg); box-shadow: 0 2px 6px var(--widget-shadow); font-size: 13px; font-weight: 400; z-index: 4; }
.comment-surface[data-attachment-corner='top-left'] { border-top-left-radius: 0; }
.comment-surface[data-attachment-corner='top-right'] { border-top-right-radius: 0; }
.comment-surface[data-attachment-corner='bottom-left'] { border-bottom-left-radius: 0; }
.comment-surface[data-attachment-corner='bottom-right'] { border-bottom-right-radius: 0; }
.comment-preview-hit-area { position: fixed; pointer-events: none; z-index: 4; }
.comment-preview { position: absolute; align-items: flex-start; gap: 8px; max-height: 96px; padding: 6px 8px; overflow: hidden; line-height: 20px; pointer-events: none; }
.comment-preview.empty { gap: 0; padding: 4px; }
.comment-preview.empty .comment-preview-body { display: none; }
.comment-preview-body { flex: 1; min-width: 0; max-height: 82px; overflow-x: hidden; overflow-y: auto; overflow-wrap: anywhere; scrollbar-width: thin; white-space: pre-wrap; }
:host(.comment-preview-active) .comment-preview-hit-area, :host(.comment-preview-active) .comment-preview { pointer-events: auto; }
.comment-preview-remove { flex: none; display: grid; place-items: center; box-sizing: border-box; width: 24px; height: 24px; margin-block: -2px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--widget-fg); cursor: pointer; font-family: inherit; }
.comment-preview-remove svg, .comment-send svg { display: block; width: 16px; height: 16px; }
.comment-preview-remove:hover, .comment-send:hover { background: var(--hover); }
.comment-composer { align-items: flex-end; gap: 6px; padding: 6px; pointer-events: auto; }
.comment-input { flex: 1; min-width: 0; resize: none; overflow: auto; scrollbar-width: none; box-sizing: border-box; margin: 0; padding: 2px 6px; background: transparent; color: inherit; border: 1px solid var(--widget-border); border-radius: 4px; outline: 0; font: inherit; line-height: 20px; caret-color: var(--focus); }
.comment-input::-webkit-scrollbar { display: none; }
.comment-input::placeholder { color: var(--placeholder); opacity: 1; }
.comment-send { box-sizing: border-box; border: 0; cursor: pointer; font-family: inherit; flex: none; width: 24px; height: 24px; padding: 0; border-radius: 4px; background: transparent; color: var(--widget-fg); display: grid; place-items: center; }
.comment-pin { position: absolute; display: grid; place-items: center; width: 22px; height: 22px; transform: translate(-11px, -11px); pointer-events: auto; z-index: 0; transition: opacity 120ms linear; }
.comment-layer.composing .comment-pin { opacity: 0; pointer-events: none; z-index: auto; }
.comment-pin:hover, .comment-pin:focus-within { z-index: 1; }
:host(.comment-preview-active) .comment-pin:not(.previewing) { opacity: 0.35; }
.comment-pin.previewing .comment-pin-bubble { width: 6px; height: 6px; border-width: 0; }
.comment-pin.previewing .comment-pin-number { opacity: 0; }
.comment-pin-bubble { box-sizing: border-box; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 1px solid var(--widget-bg); border-radius: 9999px; background: var(--button-bg); color: var(--button-fg); box-shadow: 0 2px 6px var(--widget-shadow); transition: width 140ms cubic-bezier(0.2, 0, 0, 1), height 140ms cubic-bezier(0.2, 0, 0, 1), border-width 140ms cubic-bezier(0.2, 0, 0, 1); }
.comment-pin-number { display: block; width: 100%; font-size: 11px; font-weight: 600; line-height: 12px; text-align: center; transition: opacity 80ms linear; }
.comment-send:focus-visible, .comment-preview-remove:focus-visible, .comment-pin:focus-visible, .comment-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.label { position: fixed; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 6px; max-width: min(100%, 320px); background: var(--button-bg); color: var(--button-fg); font-family: inherit; font-size: 11px; line-height: 20px; white-space: nowrap; border-radius: 2px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); z-index: 3; }
.label-info { display: inline-block; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.label-selector { font-weight: 600; }
.label-dims { flex-shrink: 0; opacity: 0.8; }
.dragbox { position: fixed; box-sizing: border-box; border: 1px dashed var(--focus); background: color-mix(in srgb, var(--focus) 12%, transparent); z-index: 2; }
`;

function pickerMain(cssPath: (el: El, doc: Doc) => string, mode: "element" | "comment" | "area", theme: PickTheme, css: string) {
  const w = window as unknown as { __agentNavPickQueue?: unknown[]; __agentNavPickStop?: () => void };
  if (w.__agentNavPickStop) w.__agentNavPickStop();
  const queue: unknown[] = (w.__agentNavPickQueue = []);
  const root = document.documentElement;
  const host = document.createElement("div");
  host.setAttribute("data-agent-nav-pick-host", "");
  host.style.cssText = "position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "closed" });
  const vars: [string, string][] = [["--focus", theme.focus], ["--button-bg", theme.buttonBg], ["--button-fg", theme.buttonFg], ["--widget-bg", theme.widgetBg], ["--widget-fg", theme.widgetFg], ["--widget-border", theme.widgetBorder], ["--widget-shadow", theme.widgetShadow], ["--placeholder", theme.placeholder], ["--hover", theme.hover], ["--pick-font", theme.font]];
  for (const [name, value] of vars) host.style.setProperty(name, value);
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: ParentNode = shadow) => {
    const el = document.createElement(tag);
    el.className = className;
    parent.appendChild(el);
    return el;
  };
  const SVG = "http://www.w3.org/2000/svg";
  const icon = (path: string) => {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  };
  const PLUS = "M8.5 3a.5.5 0 0 0-1 0v4.5H3a.5.5 0 0 0 0 1h4.5V13a.5.5 0 0 0 1 0V8.5H13a.5.5 0 0 0 0-1H8.5V3Z";
  const CLOSE = "M3.854 3.146a.5.5 0 0 0-.708.708L7.293 8l-4.147 4.146a.5.5 0 0 0 .708.708L8 8.707l4.146 4.147a.5.5 0 0 0 .708-.708L8.707 8l4.147-4.146a.5.5 0 0 0-.708-.708L8 7.293 3.854 3.146Z";

  // 댓글 뒤를 어둡게 하는 배경(윤곽 자리만 뚫림)과 윤곽
  const backdrop = document.createElementNS(SVG, "svg");
  backdrop.setAttribute("class", "comment-backdrop");
  const maskId = `an-cutout-${Math.random().toString(36).slice(2)}`;
  const defs = document.createElementNS(SVG, "defs");
  const mask = document.createElementNS(SVG, "mask");
  mask.id = maskId;
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  for (const [k, v] of [["x", "0"], ["y", "0"], ["width", "100%"], ["height", "100%"]]) mask.setAttribute(k, v);
  const white = document.createElementNS(SVG, "rect");
  white.setAttribute("width", "100%");
  white.setAttribute("height", "100%");
  white.setAttribute("fill", "white");
  const cutout = document.createElementNS(SVG, "rect");
  cutout.setAttribute("fill", "black");
  mask.append(white, cutout);
  defs.appendChild(mask);
  const fill = document.createElementNS(SVG, "rect");
  fill.setAttribute("class", "comment-backdrop-fill");
  fill.setAttribute("width", "100%");
  fill.setAttribute("height", "100%");
  fill.setAttribute("mask", `url(#${maskId})`);
  const shape = document.createElementNS(SVG, "rect");
  shape.setAttribute("class", "highlight-shape");
  shape.style.display = "none";
  backdrop.append(defs, fill, shape);
  shadow.appendChild(backdrop);
  const label = make("div", "label");
  label.style.display = "none";
  const labelInfo = make("span", "label-info", label);
  const labelSelector = make("span", "label-selector", labelInfo);
  const labelClasses = make("span", "label-classes", labelInfo);
  const labelDims = make("span", "label-dims", label);
  const dragbox = make("div", "dragbox");
  dragbox.style.display = "none";
  const layer = make("div", "comment-layer");
  const composer = make("div", "comment-surface comment-composer", layer);
  composer.style.display = "none";
  composer.setAttribute("role", "dialog");
  const input = make("textarea", "comment-input", composer);
  input.rows = 1;
  input.placeholder = "Add a comment";
  input.setAttribute("aria-label", "Comment on selected element");
  const send = make("button", "comment-send", composer);
  send.type = "button";
  send.title = "Add Comment";
  send.setAttribute("aria-label", "Add Comment");
  send.appendChild(icon(PLUS));
  const hitArea = make("div", "comment-preview-hit-area", shadow);
  hitArea.style.display = "none";
  const preview = make("div", "comment-surface comment-preview", hitArea);
  preview.style.display = "none";
  const previewBody = make("span", "comment-preview-body", preview);
  const remove = make("button", "comment-preview-remove", preview);
  remove.type = "button";
  remove.title = "Remove Comment";
  remove.setAttribute("aria-label", "Remove element comment");
  remove.appendChild(icon(CLOSE));

  const previousCursor = document.createElement("style");
  previousCursor.textContent = `/* agent-nav injected style */ * { cursor: ${mode === "area" ? "crosshair" : "default"} !important; }`;
  document.head.appendChild(previousCursor);
  root.appendChild(host);

  const pins: { number: number; target: Element; node: HTMLElement; offset: { x: number; y: number }; body: string }[] = [];
  let hovered: Element | null = null;
  let composing: { target: Element; anchor: { x: number; y: number } } | null = null;
  let previewing: (typeof pins)[number] | null = null;
  let dragStart: { x: number; y: number } | null = null;

  const bounds = (r: DOMRect) => {
    const left = Math.max(0, Math.min(r.left, innerWidth));
    const top = Math.max(0, Math.min(r.top, innerHeight));
    return { x: left, y: top, width: Math.max(left, Math.min(r.right, innerWidth)) - left, height: Math.max(top, Math.min(r.bottom, innerHeight)) - top };
  };
  const setRect = (el: SVGRectElement, b: { x: number; y: number; width: number; height: number }) => {
    el.setAttribute("x", String(b.x));
    el.setAttribute("y", String(b.y));
    el.setAttribute("width", String(b.width));
    el.setAttribute("height", String(b.height));
    el.setAttribute("rx", "2");
  };
  const showBackdrop = (target: Element) => {
    setRect(cutout, bounds(target.getBoundingClientRect()));
    backdrop.classList.remove("visible");
    requestAnimationFrame(() => backdrop.classList.add("visible"));
  };
  const hideBackdrop = () => backdrop.classList.remove("visible");
  const highlight = (el: Element | null) => {
    if (!el) {
      shape.style.display = "none";
      label.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    shape.style.display = "block";
    setRect(shape, bounds(r));
    labelSelector.textContent = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "");
    labelClasses.textContent = el.classList.length ? `.${Array.from(el.classList).join(".")}` : "";
    labelDims.textContent = `${Math.round(r.width)} \u00d7 ${Math.round(r.height)}`;
    label.style.display = "inline-flex";
    label.style.left = "0";
    const top = Math.max(0, Math.min(innerHeight - 20, r.top - 20));
    label.style.left = `${Math.max(0, Math.min(r.left, document.documentElement.clientWidth - label.offsetWidth))}px`;
    label.style.top = `${top}px`;
  };
  // 입력줄과 미리보기를 anchor(화면 좌표) 옆에 놓는다. 오른쪽과 아래에 자리가 있으면 거기, 아니면 반대쪽에 두고 붙은 모서리를 직각으로 한다.
  const layoutSurface = (surface: HTMLElement, at: { x: number; y: number }, hit?: HTMLElement) => {
    const vw = document.documentElement.clientWidth;
    let width = surface.offsetWidth;
    const room = Math.max(0, vw - 8 - at.x);
    const roomLeft = Math.max(0, at.x - 8);
    const right = width <= room || (width > roomLeft && room >= roomLeft);
    const max = right ? room : roomLeft;
    if (width > max) {
      surface.style.maxWidth = `${max}px`;
      width = surface.offsetWidth;
    }
    const height = surface.offsetHeight;
    const below = Math.max(0, innerHeight - 8 - at.y);
    const above = Math.max(0, at.y - 8);
    const down = !(height <= above || (height > below && above >= below));
    surface.dataset.attachmentCorner = `${down ? "top" : "bottom"}-${right ? "left" : "right"}`;
    const left = right ? at.x : at.x - width;
    const top = down ? at.y : Math.max(8, at.y - height);
    if (hit) {
      hit.style.left = `${left - 11}px`;
      hit.style.top = `${top - 11}px`;
      hit.style.width = `${surface.offsetWidth + 22}px`;
      hit.style.height = `${surface.offsetHeight + 22}px`;
      surface.style.left = "11px";
      surface.style.top = "11px";
    } else {
      surface.style.left = `${left}px`;
      surface.style.top = `${top}px`;
    }
  };
  const sizeInput = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  };
  const layoutPin = (pin: (typeof pins)[number]) => {
    const r = pin.target.getBoundingClientRect();
    const scroller = document.scrollingElement ?? root;
    const x = r.left + scrollX + pin.offset.x;
    const y = r.top + scrollY + pin.offset.y;
    pin.node.style.left = `${Math.max(11, Math.min(x, scroller.scrollWidth - 11))}px`;
    pin.node.style.top = `${Math.max(11, Math.min(y, scroller.scrollHeight - 11))}px`;
  };
  const hidePreview = () => {
    if (previewing) previewing.node.classList.remove("previewing");
    previewing = null;
    host.classList.remove("comment-preview-active");
    hitArea.style.display = "none";
    preview.style.display = "none";
    if (!composing) {
      hideBackdrop();
      highlight(null);
    }
  };
  const showPreview = (pin: (typeof pins)[number]) => {
    if (composing || previewing === pin) return;
    hidePreview();
    previewing = pin;
    pin.node.classList.add("previewing");
    pin.node.after(hitArea);
    previewBody.textContent = pin.body;
    preview.title = pin.body;
    preview.classList.toggle("empty", !pin.body);
    hitArea.style.display = "block";
    preview.style.display = "flex";
    host.classList.add("comment-preview-active");
    highlight(pin.target);
    showBackdrop(pin.target);
    preview.style.width = "max-content";
    preview.style.maxWidth = `${Math.min(320, document.documentElement.clientWidth - 16)}px`;
    const c = pin.node.getBoundingClientRect();
    layoutSurface(preview, { x: c.left + c.width / 2, y: c.top + c.height / 2 }, hitArea);
    const l = label.getBoundingClientRect();
    const p = preview.getBoundingClientRect();
    if (preview.dataset.attachmentCorner?.startsWith("bottom") && l.left < p.right && l.right > p.left && l.top < p.bottom && l.bottom > p.top) {
      const b = bounds(pin.target.getBoundingClientRect());
      label.style.top = `${Math.max(0, Math.min(innerHeight - 20, b.y + b.height + 2))}px`;
    }
  };
  let hideTimer = 0;
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!previewing || previewing.node.matches(":focus-within") || hitArea.matches(":hover, :focus-within")) return;
      hidePreview();
    }, 80);
  };
  hitArea.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  hitArea.addEventListener("mouseleave", scheduleHide);
  remove.addEventListener("click", () => {
    const pin = previewing;
    if (!pin) return;
    hidePreview();
    pin.node.remove();
    pins.splice(pins.indexOf(pin), 1);
    queue.push({ type: "commentRemoved", number: pin.number });
  });

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const inside = (event: Event) => event.composedPath().includes(host);
  const closeComposer = () => {
    composing = null;
    composer.style.display = "none";
    input.value = "";
    layer.classList.remove("composing");
    hideBackdrop();
    highlight(null);
  };
  const finish = (last: unknown) => {
    for (const type of ["pointermove", "scroll", "resize"]) window.removeEventListener(type, onMove, true);
    for (const [type, handler] of Object.entries(handlers)) window.removeEventListener(type, handler, true);
    host.remove();
    previousCursor.remove();
    w.__agentNavPickStop = undefined;
    queue.push(last);
  };
  const describe = (el: Element) => ({ url: location.href, title: document.title, tag: el.tagName.toLowerCase(), selector: cssPath(el as unknown as El, document), html: el.outerHTML.slice(0, 20000), text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200), rect: (({ left, top, width, height }) => ({ x: left, y: top, width, height }))(el.getBoundingClientRect()) });
  const pickAt = (x: number, y: number) => document.elementsFromPoint(x, y).find((el) => el !== host && !host.contains(el)) ?? null;
  const onMove = (event: Event) => {
    if (event.type === "pointermove" && !inside(event)) {
      const e = event as PointerEvent;
      if (mode === "area") {
        if (dragStart) {
          dragbox.style.display = "block";
          dragbox.style.left = `${Math.min(dragStart.x, e.clientX)}px`;
          dragbox.style.top = `${Math.min(dragStart.y, e.clientY)}px`;
          dragbox.style.width = `${Math.abs(e.clientX - dragStart.x)}px`;
          dragbox.style.height = `${Math.abs(e.clientY - dragStart.y)}px`;
          swallow(event);
        }
      } else if (!composing && !previewing) {
        hovered = pickAt(e.clientX, e.clientY);
        highlight(hovered);
      }
    }
    if (composing) {
      showBackdrop(composing.target);
      highlight(composing.target);
      layoutSurface(composer, { x: composing.anchor.x - scrollX, y: composing.anchor.y - scrollY });
    }
    for (const pin of pins) layoutPin(pin);
  };
  const openComposer = (target: Element, at: { x: number; y: number }) => {
    hidePreview();
    composing = { target, anchor: { x: at.x + scrollX, y: at.y + scrollY } };
    showBackdrop(target);
    layer.classList.add("composing");
    input.value = "";
    composer.style.display = "flex";
    sizeInput();
    highlight(target);
    layoutSurface(composer, at);
    input.focus({ preventScroll: true });
  };
  const submit = () => {
    if (!composing) return;
    const { target, anchor } = composing;
    const body = input.value.replace(/\r?\n/g, " ").slice(0, 2000);
    const number = pins.reduce((n, p) => Math.max(n, p.number), 0) + 1;
    closeComposer();
    const node = make("div", "comment-pin", layer);
    node.tabIndex = 0;
    node.setAttribute("role", "note");
    const bubble = make("span", "comment-pin-bubble", node);
    make("span", "comment-pin-number", bubble).textContent = String(number);
    node.title = body || `Element comment ${number}`;
    const r = target.getBoundingClientRect();
    const pin = { number, target, node, offset: { x: anchor.x - (r.left + scrollX), y: anchor.y - (r.top + scrollY) }, body };
    node.addEventListener("pointermove", () => showPreview(pin));
    node.addEventListener("focusin", () => showPreview(pin));
    node.addEventListener("focusout", scheduleHide);
    pins.push(pin);
    layoutPin(pin);
    queue.push({ type: "comment", number, comment: body, ...describe(target) });
  };
  input.addEventListener("input", () => {
    sizeInput();
    if (composing) layoutSurface(composer, { x: composing.anchor.x - scrollX, y: composing.anchor.y - scrollY });
  });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  for (const type of ["keypress", "keyup"]) input.addEventListener(type, (event) => event.stopPropagation());
  send.addEventListener("click", submit);

  const onClick = (event: Event) => {
    if (inside(event)) return;
    swallow(event);
    if (event.type !== "click") return;
    const e = event as MouseEvent;
    if (composing) {
      closeComposer();
      return;
    }
    if (mode === "area") return;
    const el = pickAt(e.clientX, e.clientY);
    if (!el || el === root) return;
    if (mode === "comment") {
      openComposer(el, { x: e.clientX, y: e.clientY });
      return;
    }
    queue.push({ type: "element", ...describe(el) });
    finish({ type: "done" });
  };
  const onDown = (event: Event) => {
    if (inside(event)) return;
    swallow(event);
    if (mode === "area" && event.type === "pointerdown" && (event as PointerEvent).button === 0) {
      dragStart = { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY };
      dragbox.style.cssText = `display:block;left:${dragStart.x}px;top:${dragStart.y}px;width:0;height:0`;
    }
  };
  const onUp = (event: Event) => {
    if (inside(event)) return;
    swallow(event);
    if (mode !== "area" || !dragStart || event.type !== "pointerup") return;
    const e = event as PointerEvent;
    const x = Math.min(dragStart.x, e.clientX);
    const y = Math.min(dragStart.y, e.clientY);
    const width = Math.abs(e.clientX - dragStart.x);
    const height = Math.abs(e.clientY - dragStart.y);
    dragStart = null;
    dragbox.style.display = "none";
    // 클릭 정도의 작은 끌기는 영역이 아니다. 다시 끌 수 있게 둔다.
    if (width < 4 || height < 4) return;
    queue.push({ type: "area", url: location.href, title: document.title, rect: { x, y, width, height } });
    finish({ type: "done" });
  };
  const onKey = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key !== "Escape") return;
    swallow(event);
    if (composing) {
      closeComposer();
      return;
    }
    finish({ type: queue.length > 0 && mode === "comment" ? "done" : "cancelled" });
  };
  const handlers: Record<string, (event: Event) => void> = { click: onClick, keydown: onKey, pointerdown: onDown, mousedown: onDown, pointerup: onUp, mouseup: onUp };
  for (const type of ["contextmenu", "dblclick", "auxclick"]) handlers[type] = (event) => !inside(event) && swallow(event);
  for (const type of ["pointermove", "scroll", "resize"]) window.addEventListener(type, onMove, true);
  for (const [type, handler] of Object.entries(handlers)) window.addEventListener(type, handler, true);
  w.__agentNavPickStop = () => finish({ type: "cancelled" });
}

export type PickMode = "element" | "comment" | "area";
export const pickScript = (mode: PickMode, theme: PickTheme) => `(${pickerMain.toString()})(${cssPathOf.toString()}, ${JSON.stringify(mode)}, ${JSON.stringify(theme)}, ${JSON.stringify(PICK_CSS)})`;
// 쌓인 결과를 비우며 읽는다. 없으면 null.
export const PICK_READ_SCRIPT = "(()=>{const q=window.__agentNavPickQueue;return q&&q.length?JSON.stringify(q.splice(0)):null})()";
export const PICK_STOP_SCRIPT = "window.__agentNavPickStop && window.__agentNavPickStop()";
