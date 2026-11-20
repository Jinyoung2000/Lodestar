// 닫힌 사이드바 hover 미리보기 상태 기계(web/peekController.ts)를 가짜 타이머로 확인한다. 실행: npm test
import { createPeekController, isPeekHeld, PEEK_CLOSE_DELAY_MS, PEEK_OPEN_DELAY_MS, type PeekTimers } from "../web/peekController";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

function harness(initial: { pinned?: boolean; held?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: PeekTimers = {
    set: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  const flags = { pinned: initial.pinned ?? false, held: initial.held ?? false };
  const peek = createPeekController({ timers, canOpen: () => !flags.pinned, isHeld: () => flags.held });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { peek, flags, advance, pending };
}

test("opens only after the open delay", () => {
  const h = harness();
  h.peek.enter("button");
  h.advance(PEEK_OPEN_DELAY_MS - 1);
  expect(!h.peek.isOpen(), "not open before the delay");
  h.advance(1);
  expect(h.peek.isOpen(), "open at the delay");
  return `${PEEK_OPEN_DELAY_MS}ms`;
});

test("a quick graze never opens", () => {
  const h = harness();
  h.peek.enter("edge");
  h.advance(PEEK_OPEN_DELAY_MS - 50);
  h.peek.leave("edge");
  h.advance(1000);
  expect(!h.peek.isOpen() && h.pending.size === 0, "no open, no timer left");
  return "ok";
});

test("closes after the close delay once the pointer leaves everything", () => {
  const h = harness();
  h.peek.enter("button");
  h.advance(PEEK_OPEN_DELAY_MS);
  h.peek.leave("button");
  h.advance(PEEK_CLOSE_DELAY_MS - 1);
  expect(h.peek.isOpen(), "still open before the delay");
  h.advance(1);
  expect(!h.peek.isOpen(), "closed at the delay");
  return `${PEEK_CLOSE_DELAY_MS}ms`;
});

test("moving from the button onto the panel keeps it open", () => {
  const h = harness();
  h.peek.enter("button");
  h.advance(PEEK_OPEN_DELAY_MS);
  h.peek.leave("button");
  h.advance(PEEK_CLOSE_DELAY_MS - 100);
  h.peek.enter("panel");
  h.advance(5000);
  expect(h.peek.isOpen(), "panel hover cancels the close");
  h.peek.leave("panel");
  h.advance(PEEK_CLOSE_DELAY_MS);
  expect(!h.peek.isOpen(), "closes after leaving the panel");
  return "ok";
});

test("a menu or focus inside holds it open until released", () => {
  const h = harness();
  h.peek.enter("panel");
  h.advance(PEEK_OPEN_DELAY_MS);
  h.flags.held = true;
  h.peek.leave("panel");
  h.advance(5000);
  expect(h.peek.isOpen(), "held panel stays open");
  h.flags.held = false;
  h.peek.refresh();
  h.advance(PEEK_CLOSE_DELAY_MS - 1);
  expect(h.peek.isOpen(), "close delay starts at release, not before");
  h.advance(1);
  expect(!h.peek.isOpen(), "closed after release plus delay");
  return "ok";
});

test("held again during the close delay cancels the close", () => {
  const h = harness();
  h.peek.enter("panel");
  h.advance(PEEK_OPEN_DELAY_MS);
  h.peek.leave("panel");
  h.advance(PEEK_CLOSE_DELAY_MS - 10);
  h.flags.held = true;
  h.advance(20);
  expect(h.peek.isOpen(), "timer fired but held, stays open");
  return "ok";
});

test("pinned sidebar never peeks, and pinning closes an open peek", () => {
  const h = harness({ pinned: true });
  h.peek.enter("button");
  h.advance(1000);
  expect(!h.peek.isOpen(), "no open while pinned");
  const g = harness();
  g.peek.enter("button");
  g.advance(PEEK_OPEN_DELAY_MS);
  g.flags.pinned = true;
  g.peek.close();
  expect(!g.peek.isOpen(), "close() ends the peek");
  g.advance(1000);
  expect(!g.peek.isOpen(), "stays closed");
  return "ok";
});

test("close() clears stale zones, so a later graze starts fresh", () => {
  const h = harness();
  h.peek.enter("button");
  h.advance(PEEK_OPEN_DELAY_MS);
  h.peek.close();
  h.peek.enter("edge");
  h.advance(PEEK_OPEN_DELAY_MS);
  expect(h.peek.isOpen(), "reopens");
  h.peek.leave("edge");
  h.advance(PEEK_CLOSE_DELAY_MS);
  expect(!h.peek.isOpen(), "button zone from before did not linger");
  return "ok";
});

test("subscribers hear open and close once each", () => {
  const h = harness();
  let calls = 0;
  h.peek.subscribe(() => calls++);
  h.peek.enter("panel");
  h.advance(PEEK_OPEN_DELAY_MS);
  h.peek.close();
  h.peek.close();
  expect(calls === 2, `calls=${calls}`);
  return "2";
});

test("isPeekHeld: keyboard focus and open menus hold, mouse focus does not", () => {
  const panel = { contains: (el: unknown) => el === focusable, querySelector: () => null } as unknown as HTMLElement;
  const focusable = { matches: (q: string) => q === ":focus-visible" && visible } as unknown as Element;
  let visible = false;
  let menuOpen = false;
  const doc = { activeElement: focusable, body: {}, querySelector: () => (menuOpen ? {} : null) } as unknown as Document;
  expect(!isPeekHeld(panel, doc), "mouse focus (not focus-visible) does not hold");
  visible = true;
  expect(isPeekHeld(panel, doc), "focus-visible inside holds");
  visible = false;
  menuOpen = true;
  expect(isPeekHeld(panel, doc), "a portal menu holds");
  expect(!isPeekHeld(null, doc), "no panel, nothing held");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
