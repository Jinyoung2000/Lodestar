// run_playwright_code 의 `page` 객체. 별도의 숨은 샌드박스 창(electron/pwRunner.ts)의 페이지 안에서 돈다. 그 창에는 Node 도 데몬 주소도 없고, 메인 프로세스와는 `__pwHost.call(op, args)` 하나로만 통한다.
// 에이전트가 쓴 코드는 여기서 실행되고, 공유 페이지에 닿는 일은 모두 메인 프로세스가 그 페이지 하나에만 하는 연산(locate, mouse, key, goto, evaluate, ...)으로 바뀐다.
// 이 함수는 문자열로 바뀌어 샌드박스 창에 들어가므로 자기 안의 것과 인자로 받은 것만 쓴다. 쓰는 쪽은 `(${runtimeMain})(code, parseSelector, describeChain)` 로 부른다.
import type { ChainStep } from "./pwEngine";

type Host = { call(op: string, args?: unknown): Promise<unknown> };

export async function runtimeMain(code: string, parseSelector: (input: string) => ChainStep[], describeChain: (chain: ChainStep[]) => string): Promise<string> {
  const host = (window as unknown as { __pwHost: Host }).__pwHost;
  const ACTION_TIMEOUT = 10_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // page.url() 은 Playwright 에서 동기 함수라서, 이동할 수 있는 연산 뒤마다 주소를 읽어 둔다.
  let currentUrl = "";
  const MOVES = new Set(["goto", "nav", "mouse", "key", "typeChars", "waitLoad", "drag"]);
  const op = async (name: string, args?: unknown) => {
    try {
      const result = await host.call(name, args);
      if (MOVES.has(name)) currentUrl = (await host.call("info", { what: "url" })) as string;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  currentUrl = (await host.call("info", { what: "url" }).catch(() => "")) as string;
  type Opts = { timeout?: number; force?: boolean; button?: string; clickCount?: number; delay?: number; position?: { x: number; y: number } };
  const rx = (value: RegExp) => ({ src: value.source, flags: value.flags });
  const textStep = (text: string | RegExp, options?: { exact?: boolean }): ChainStep => (text instanceof RegExp ? { k: "text", v: "", re: rx(text) } : { k: "text", v: text, exact: options?.exact === true });
  const kinds = ["label", "placeholder", "alt", "title"] as const;

  class Keyboard {
    async press(key: string) {
      await op("key", { key });
    }
    async down(key: string) {
      await op("key", { key, phase: "down" });
    }
    async up(key: string) {
      await op("key", { key, phase: "up" });
    }
    async type(text: string, options?: { delay?: number }) {
      await op("typeChars", { text, delay: options?.delay ?? 0 });
    }
    async insertText(text: string) {
      await op("insert", { text });
    }
  }

  class Mouse {
    async move(x: number, y: number) {
      await op("mouse", { type: "move", x, y });
    }
    async down(options?: { button?: string }) {
      await op("mouse", { type: "down", button: options?.button ?? "left" });
    }
    async up(options?: { button?: string }) {
      await op("mouse", { type: "up", button: options?.button ?? "left" });
    }
    async click(x: number, y: number, options?: { button?: string; clickCount?: number }) {
      await op("mouse", { type: "click", x, y, button: options?.button ?? "left", clickCount: options?.clickCount ?? 1 });
    }
    async dblclick(x: number, y: number) {
      await op("mouse", { type: "click", x, y, button: "left", clickCount: 2 });
    }
    async wheel(deltaX: number, deltaY: number) {
      await op("mouse", { type: "wheel", deltaX, deltaY });
    }
  }

  class Locator {
    constructor(
      readonly chain: ChainStep[],
      readonly owner: Page,
    ) {}
    private extend(step: ChainStep) {
      return new Locator([...this.chain, step], this.owner);
    }
    private async locate(mode: string, arg: unknown, options?: Opts, strict = true) {
      const res = (await op("locate", { describe: describeChain(this.chain), req: { chain: this.chain, mode, arg, timeout: options?.timeout ?? ACTION_TIMEOUT, strict } })) as { ok: boolean; value?: unknown; error?: string };
      if (!res.ok) throw new Error(res.error ?? "Locator failed.");
      return res.value as never;
    }
    locator(selector: string | Locator, options?: { hasText?: string | RegExp; has?: Locator }) {
      const next = selector instanceof Locator ? this.owner.locatorOf([...this.chain, ...selector.chain]) : this.owner.locatorOf([...this.chain, ...parseSelector(selector)]);
      return options ? next.filter(options) : next;
    }
    getByText(text: string | RegExp, options?: { exact?: boolean }) {
      return this.extend(textStep(text, options));
    }
    getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }) {
      const step: ChainStep = { k: "role", v: role };
      if (options?.name instanceof RegExp) step.nameRe = rx(options.name);
      else if (options?.name !== undefined) step.name = options.name;
      step.exact = options?.exact === true;
      return this.extend(step);
    }
    getByLabel(text: string, options?: { exact?: boolean }) {
      return this.extend({ k: "label", v: text, exact: options?.exact === true });
    }
    getByPlaceholder(text: string, options?: { exact?: boolean }) {
      return this.extend({ k: "placeholder", v: text, exact: options?.exact === true });
    }
    getByAltText(text: string, options?: { exact?: boolean }) {
      return this.extend({ k: "alt", v: text, exact: options?.exact === true });
    }
    getByTitle(text: string, options?: { exact?: boolean }) {
      return this.extend({ k: "title", v: text, exact: options?.exact === true });
    }
    getByTestId(id: string) {
      return this.extend({ k: "testid", v: id, exact: true });
    }
    first() {
      return this.extend({ k: "nth", v: 0 });
    }
    last() {
      return this.extend({ k: "nth", v: -1 });
    }
    nth(index: number) {
      return this.extend({ k: "nth", v: index });
    }
    filter(options: { hasText?: string | RegExp; hasNotText?: string | RegExp; has?: Locator }) {
      return this.extend({ k: "filter", hasText: typeof options.hasText === "string" ? options.hasText : options.hasText?.source, hasNotText: typeof options.hasNotText === "string" ? options.hasNotText : options.hasNotText?.source, has: options.has?.chain });
    }
    async count() {
      return (await this.locate("count", undefined, { timeout: 0 }, false)) as number;
    }
    async isVisible() {
      return (await this.locate("isVisible", undefined, { timeout: 0 }, false)) as boolean;
    }
    async isHidden() {
      return (await this.locate("isHidden", undefined, { timeout: 0 }, false)) as boolean;
    }
    async textContent(options?: Opts) {
      return (await this.locate("text", undefined, options)) as string | null;
    }
    async innerText(options?: Opts) {
      return (await this.locate("innerText", undefined, options)) as string;
    }
    async innerHTML(options?: Opts) {
      return (await this.locate("innerHTML", undefined, options)) as string;
    }
    async getAttribute(name: string, options?: Opts) {
      return (await this.locate("attr", name, options)) as string | null;
    }
    async inputValue(options?: Opts) {
      return (await this.locate("value", undefined, options)) as string;
    }
    async isChecked(options?: Opts) {
      return (await this.locate("checked", undefined, options)) as boolean;
    }
    async isEnabled(options?: Opts) {
      return (await this.locate("enabled", undefined, options)) as boolean;
    }
    async isDisabled(options?: Opts) {
      return !(await this.isEnabled(options));
    }
    async isEditable(options?: Opts) {
      return (await this.locate("editable", undefined, options)) as boolean;
    }
    async allTextContents() {
      return (await this.locate("allText", undefined, { timeout: 0 }, false)) as string[];
    }
    async allInnerTexts() {
      return (await this.locate("allInner", undefined, { timeout: 0 }, false)) as string[];
    }
    async boundingBox(options?: Opts) {
      return (await this.locate("box", undefined, options)) as { x: number; y: number; width: number; height: number };
    }
    async waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }) {
      await this.locate("waitFor", options?.state ?? "visible", options, false);
    }
    async scrollIntoViewIfNeeded(options?: Opts) {
      await this.locate("scroll", undefined, options);
    }
    async focus(options?: Opts) {
      await this.locate("focus", undefined, options);
    }
    async blur(options?: Opts) {
      await this.locate("blur", undefined, options);
    }
    async evaluate(fn: ((el: Element, arg?: unknown) => unknown) | string, arg?: unknown) {
      return await this.locate("eval", { fn: typeof fn === "string" ? `(el) => (${fn})` : fn.toString(), arg }, undefined);
    }
    private async point(options?: Opts) {
      const p = (await this.locate("point", undefined, options)) as { x: number; y: number; width: number; height: number };
      if (options?.position) return { x: p.x - p.width / 2 + options.position.x, y: p.y - p.height / 2 + options.position.y, width: p.width, height: p.height };
      return p;
    }
    private async press1(options: Opts | undefined, clickCount: number, button: string) {
      const p = await this.point(options);
      if (p.width <= 0 || p.height <= 0) {
        await this.locate("domClick", undefined, options);
        return;
      }
      await op("mouse", { type: "click", x: p.x, y: p.y, button, clickCount });
    }
    async click(options?: Opts) {
      await this.press1(options, options?.clickCount ?? 1, options?.button ?? "left");
    }
    async dblclick(options?: Opts) {
      await this.press1(options, 2, options?.button ?? "left");
    }
    async hover(options?: Opts) {
      const p = await this.point(options);
      await op("mouse", { type: "move", x: p.x, y: p.y });
    }
    async fill(value: string, options?: Opts) {
      const how = await this.locate("fill", value, options);
      if (how === "insert") await op("insert", { text: value });
    }
    async clear(options?: Opts) {
      await this.fill("", options);
    }
    async pressSequentially(text: string, options?: Opts) {
      await this.locate("focus", undefined, options);
      await op("typeChars", { text, delay: options?.delay ?? 0 });
    }
    async type(text: string, options?: Opts) {
      await this.pressSequentially(text, options);
    }
    async press(key: string, options?: Opts) {
      await this.locate("focus", undefined, options);
      await op("key", { key });
    }
    async check(options?: Opts) {
      await this.setChecked(true, options);
    }
    async uncheck(options?: Opts) {
      await this.setChecked(false, options);
    }
    async setChecked(checked: boolean, options?: Opts) {
      const r = (await this.locate("check", checked, options)) as "same" | { x: number; y: number; width: number; height: number };
      if (r !== "same") await op("mouse", { type: "click", x: r.x, y: r.y, button: "left", clickCount: 1 });
    }
    async selectOption(value: unknown, options?: Opts) {
      return await this.locate("select", value, options);
    }
    async dragTo(target: Locator, options?: Opts) {
      const from = await this.point(options);
      const to = await target.point(options);
      await op("drag", { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
    }
    async screenshot() {
      const box = (await this.locate("box", undefined, undefined)) as { x: number; y: number; width: number; height: number };
      return this.owner.shotResult((await op("screenshot", { rect: box })) as string);
    }
    toString() {
      return describeChain(this.chain);
    }
  }

  class Page {
    keyboard = new Keyboard();
    mouse = new Mouse();
    locatorOf(chain: ChainStep[]) {
      return new Locator(chain, this);
    }
    shotResult(base64: string) {
      return { length: Math.floor((base64.length * 3) / 4), toString: (encoding?: string) => (encoding === "base64" || encoding === undefined ? base64 : base64), base64 };
    }
    locator(selector: string | Locator, options?: { hasText?: string | RegExp; has?: Locator }) {
      const base = selector instanceof Locator ? selector : this.locatorOf(parseSelector(selector));
      return options ? base.filter(options) : base;
    }
    getByText(text: string | RegExp, options?: { exact?: boolean }) {
      return this.locatorOf([textStep(text, options)]);
    }
    getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }) {
      return this.locatorOf([]).getByRole(role, options);
    }
    getByLabel(text: string, options?: { exact?: boolean }) {
      return this.locatorOf([{ k: kinds[0], v: text, exact: options?.exact === true }]);
    }
    getByPlaceholder(text: string, options?: { exact?: boolean }) {
      return this.locatorOf([{ k: "placeholder", v: text, exact: options?.exact === true }]);
    }
    getByAltText(text: string, options?: { exact?: boolean }) {
      return this.locatorOf([{ k: "alt", v: text, exact: options?.exact === true }]);
    }
    getByTitle(text: string, options?: { exact?: boolean }) {
      return this.locatorOf([{ k: "title", v: text, exact: options?.exact === true }]);
    }
    getByTestId(id: string) {
      return this.locatorOf([{ k: "testid", v: id, exact: true }]);
    }
    async goto(url: string) {
      await op("goto", { url });
      return null;
    }
    async reload() {
      await op("nav", { action: "reload" });
      return null;
    }
    async goBack() {
      await op("nav", { action: "back" });
      return null;
    }
    async goForward() {
      await op("nav", { action: "forward" });
      return null;
    }
    url() {
      return currentUrl;
    }
    async title() {
      return (await op("info", { what: "title" })) as string;
    }
    async content() {
      return (await op("info", { what: "content" })) as string;
    }
    async viewportSize() {
      return (await op("info", { what: "viewport" })) as { width: number; height: number };
    }
    async bringToFront() {
      return undefined;
    }
    async evaluate(fn: ((arg?: unknown) => unknown) | string, arg?: unknown) {
      return (await op("evaluate", { source: typeof fn === "string" ? `() => (${fn})` : fn.toString(), arg })) as unknown;
    }
    async waitForTimeout(ms: number) {
      await sleep(ms);
    }
    async waitForLoadState() {
      await op("waitLoad", {});
    }
    async waitForURL(url: string | RegExp, options?: { timeout?: number }) {
      const deadline = Date.now() + (options?.timeout ?? ACTION_TIMEOUT);
      for (;;) {
        const now = (await op("info", { what: "url" })) as string;
        currentUrl = now;
        if (typeof url === "string" ? now === url || now.includes(url.replace(/\*+/g, "")) : url.test(now)) return;
        if (Date.now() > deadline) throw new Error(`Timeout waiting for URL ${String(url)} (now ${now}).`);
        await sleep(100);
      }
    }
    async waitForSelector(selector: string, options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }) {
      await this.locator(selector).first().waitFor(options);
    }
    async waitForFunction(fn: ((arg?: unknown) => unknown) | string, arg?: unknown, options?: { timeout?: number }) {
      const deadline = Date.now() + (options?.timeout ?? ACTION_TIMEOUT);
      for (;;) {
        const value = await this.evaluate(fn, arg);
        if (value) return value;
        if (Date.now() > deadline) throw new Error("Timeout waiting for function.");
        await sleep(100);
      }
    }
    async screenshot(options?: { fullPage?: boolean }) {
      return this.shotResult((await op("screenshot", { fullPage: options?.fullPage === true })) as string);
    }
    async dragAndDrop(source: string, target: string) {
      await this.locator(source).dragTo(this.locator(target));
    }
  }
  // 선택자를 받는 지름길(page.click("a") 등)은 locator 로 넘긴다.
  const page = new Page() as Page & Record<string, unknown>;
  for (const name of ["click", "dblclick", "hover", "fill", "type", "press", "check", "uncheck", "selectOption", "textContent", "innerText", "innerHTML", "getAttribute", "inputValue", "isVisible", "isChecked", "isEnabled", "isDisabled", "focus"] as const) {
    page[name] = (selector: string, ...rest: unknown[]) => (page.locator(selector).first() as unknown as Record<string, (...a: unknown[]) => unknown>)[name === "type" ? "pressSequentially" : name](...rest);
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (page: unknown) => Promise<unknown>;
    const result = await new AsyncFunction("page", code)(page);
    let text: string | undefined;
    try {
      text = result === undefined ? undefined : JSON.stringify(result);
    } catch {
      text = JSON.stringify(String(result));
    }
    return JSON.stringify({ result: text === undefined ? null : JSON.parse(text), has: text !== undefined });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}
