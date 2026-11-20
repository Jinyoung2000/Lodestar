import { chipIdentity, chipTitle, findDuplicate, hashBytes, nameTails } from "../web/attachDedupe";
type Chip = Parameters<typeof chipIdentity>[0] & { id: string; text?: string | null };

const dirs: Record<string, string> = { w1: "/Users/g/app-client", w2: "/Users/g/app-client.worktrees/x", nested: "/Users/g/app-client/app-webview", tmp: "/private/tmp/repo" };
const dirOf = (id: string) => dirs[id];

const file = (id: string, path: string, ws = "w1", start: number | null = null, end: number | null = start): Chip => ({ id, workspaceId: ws, path, startLine: start, endLine: end });
const dup = (existing: Chip[], incoming: Chip) => findDuplicate(existing, incoming, dirOf)?.id ?? null;
const tails = (chips: Chip[]) => Object.fromEntries(nameTails(chips, dirOf));

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const equal = (actual: unknown, wanted: unknown, detail: string) => expect(JSON.stringify(actual) === JSON.stringify(wanted), `${detail}: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);

const cases: { name: string; run: () => void | Promise<void> }[] = [];
const test = (name: string, run: () => void | Promise<void>) => cases.push({ name, run });

test("메모 칩은 메모 id 가 같으면 중복이고, 같은 id 의 파일과는 섞이지 않는다 (NOTES)", () => {
  const note = (id: string, path: string): Chip => ({ id, workspaceId: null, path, startLine: null, endLine: null, note: { title: "t" } });
  equal(dup([note("a", "mvex4c2e-465100")], note("b", "mvex4c2e-465100")), "a", "같은 메모를 두 번");
  equal(dup([note("a", "mvex4c2e-465100")], note("b", "mvex4c2f-111111")), null, "다른 메모");
  equal(dup([note("a", "mvex4c2e-465100")], file("b", "mvex4c2e-465100")), null, "메모 id 와 같은 이름의 파일");
  equal(tails([note("a", "x-111111"), note("b", "y-222222")]), {}, "메모 칩에는 이름 꼬리가 붙지 않는다");
});

test("같은 경로의 파일 전체는 중복", () => {
  equal(dup([file("a", "src/sdks/jobs.ts")], file("b", "src/sdks/jobs.ts")), "a", "같은 파일을 두 번");
  equal(dup([file("a", "src/sdks/jobs.ts")], file("b", "src/api/jobs.ts")), null, "이름만 같은 다른 파일");
});

test("경로 표기가 달라도 같은 절대 경로면 중복 (./, .., 절대 경로, 겹치는 워크스페이스)", () => {
  equal(dup([file("a", "src/sdks/jobs.ts")], file("b", "./src/../src/sdks/jobs.ts")), "a", "./ 와 .. 정리");
  equal(dup([file("a", "src/sdks/jobs.ts")], file("b", "/Users/g/app-client/src/sdks/jobs.ts")), "a", "절대 경로로 넣음");
  equal(dup([file("a", "app-webview/src/jobs.ts")], file("b", "src/jobs.ts", "nested")), "a", "바깥 워크스페이스 기준과 안쪽 워크스페이스 기준");
  equal(dup([file("a", "x.ts", "tmp")], file("b", "x.ts", "tmp")), "a", "/private/tmp 아래");
  equal(dup([file("a", "x.ts", "tmp")], { ...file("b", "/tmp/repo/x.ts", "w1") }), "a", "/private/tmp 와 /tmp 는 같은 폴더");
});

test("같은 상대 경로라도 다른 워크스페이스(다른 폴더)면 다른 파일", () => {
  equal(dup([file("a", "src/jobs.ts", "w1")], file("b", "src/jobs.ts", "w2")), null, "워크스페이스가 다름");
});

test("파일 전체와 선택 범위는 서로 다른 칩, 같은 범위만 중복", () => {
  const whole = file("w", "a.ts");
  const range = file("r", "a.ts", "w1", 3, 9);
  equal(dup([whole], file("n", "a.ts", "w1", 3, 9)), null, "전체가 있어도 범위는 붙는다");
  equal(dup([range], file("n", "a.ts")), null, "범위가 있어도 전체는 붙는다");
  equal(dup([whole, range], file("n", "a.ts", "w1", 3, 9)), "r", "같은 범위는 중복");
  equal(dup([whole, range], file("n", "a.ts", "w1", 3, 10)), null, "다른 범위는 붙는다");
  equal(dup([whole, range], file("n", "a.ts", "w1", 4, 9)), null, "시작 줄이 다르면 붙는다");
  equal(dup([file("one", "a.ts", "w1", 5, 5)], file("n", "a.ts", "w1", 5, 5)), "one", "한 줄 범위");
});

test("선택한 글(text)이 달라도 범위가 같으면 중복 (VS Code 도 range 로만 본다)", () => {
  equal(dup([{ ...file("a", "a.ts", "w1", 1, 2), text: "old" }], { ...file("b", "a.ts", "w1", 1, 2), text: "new" }), "a", "text 는 보지 않는다");
});

test("세션 요약과 인계 문서는 같은 세션이면 중복", () => {
  const session = (id: string, agent: string): Chip => ({ id, workspaceId: "w1", path: agent, startLine: null, endLine: null, session: { title: "t" } });
  equal(dup([session("a", "s1")], session("b", "s1")), "a", "같은 세션 요약");
  equal(dup([session("a", "s1")], session("b", "s2")), null, "다른 세션");
  const handoff = (id: string, src: string): Chip => ({ id, workspaceId: "w1", path: src, startLine: null, endLine: null, handoff: { sourceId: src, title: "t", status: "ready", id: "h" } });
  equal(dup([handoff("a", "s1")], handoff("b", "s1")), "a", "같은 세션의 인계");
  equal(dup([handoff("a", "s1")], session("b", "s1")), null, "인계와 요약은 서로 다른 종류");
});

test("이미지는 내용 해시가 같으면 이름이 달라도 중복, 해시가 없으면 거르지 않는다", () => {
  const image = (id: string, name: string, hash?: string): Chip => ({ id, workspaceId: null, path: name, startLine: null, endLine: null, image: { mediaType: "image/png", data: "", thumb: "", name, bytes: 1, ...(hash ? { hash } : {}) } });
  equal(dup([image("a", "one.png", "h1")], image("b", "two.png", "h1")), "a", "해시가 같다");
  equal(dup([image("a", "one.png", "h1")], image("b", "one.png", "h2")), null, "이름이 같아도 해시가 다르다");
  equal(dup([image("a", "one.png")], image("b", "one.png")), null, "해시 없는 옛 칩");
});

test("브라우저 캡처는 찍을 때마다 다른 스냅샷이라 거르지 않는다", () => {
  const page: Chip = { id: "a", workspaceId: null, path: "http://x", startLine: null, endLine: null, browser: { kind: "page", url: "http://x", title: "x", shot: null } };
  equal(dup([page], { ...page, id: "b" }), null, "같은 주소의 페이지 캡처");
});

test("hashBytes 는 내용이 같으면 같고 다르면 다르다", async () => {
  const a = await hashBytes(new Uint8Array([1, 2, 3]).buffer);
  const b = await hashBytes(new Uint8Array([1, 2, 3]).buffer);
  const c = await hashBytes(new Uint8Array([1, 2, 4]).buffer);
  expect(a === b && a !== c && /^[0-9a-f]{64}$/.test(a), `SHA-256 16진수: ${a}`);
});

test("이름이 같은 다른 파일이 함께 있으면 구분 꼬리를 붙이고, 겹치지 않으면 붙이지 않는다", () => {
  equal(tails([file("a", "src/sdks/jobs.ts"), file("b", "src/api/jobs.ts")]), { a: "sdks", b: "api" }, "상위 폴더 한 칸");
  equal(tails([file("a", "src/sdks/jobs.ts"), file("b", "src/sdks/user.ts")]), {}, "이름이 다르면 없음");
  equal(tails([file("a", "src/sdks/jobs.ts"), file("b", "src/sdks/jobs.ts", "w1", 3, 5)]), {}, "같은 파일의 전체와 범위는 구분할 필요 없음");
});

test("상위 폴더 이름까지 같으면 두 칸으로 늘린다", () => {
  equal(tails([file("a", "web/src/jobs.ts"), file("b", "server/src/jobs.ts")]), { a: "web/src", b: "server/src" }, "src 가 같아서 한 칸 더");
  equal(tails([file("a", "jobs.ts"), file("b", "src/jobs.ts")]), { a: "app-client", b: "src" }, "워크스페이스 루트 파일은 워크스페이스 폴더 이름");
});

test("같은 파일의 여러 칩은 같은 꼬리를 받고, 세 파일이 겹쳐도 각자 구분된다", () => {
  const result = tails([file("a", "x/jobs.ts"), file("a2", "x/jobs.ts", "w1", 1, 2), file("b", "y/jobs.ts"), file("c", "z/jobs.ts")]);
  equal(result, { a: "x", a2: "x", b: "y", c: "z" }, "세 파일");
});

test("워크스페이스가 다른 같은 상대 경로는 워크스페이스 폴더로 구분한다", () => {
  equal(tails([file("a", "src/jobs.ts", "w1"), file("b", "src/jobs.ts", "w2")]), { a: "app-client/src", b: "x/src" }, "서로 다른 폴더 둘");
});

test("툴팁은 전체 상대 경로와 줄 범위", () => {
  equal(chipTitle(file("a", "src/sdks/jobs.ts")), "src/sdks/jobs.ts", "전체");
  equal(chipTitle(file("a", "src/sdks/jobs.ts", "w1", 3, 9)), "src/sdks/jobs.ts:3-9", "범위");
  equal(chipTitle(file("a", "src/sdks/jobs.ts", "w1", 4, 4)), "src/sdks/jobs.ts:4", "한 줄");
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok - ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL - ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
