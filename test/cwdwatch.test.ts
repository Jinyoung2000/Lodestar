// B2-20: 작업 폴더 감시(server/cwdWatch.ts)를 임시 폴더로 시험한다. 데몬도 모델도 필요 없다.
// 실행: npm test
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDirectory, watchDirectory } from "../server/cwdWatch";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-cwd-")));
try {
  const dir = join(root, "work");
  mkdirSync(dir);
  expect(await isDirectory(dir), "있는 폴더");
  expect(!(await isDirectory(join(root, "nope"))), "없는 폴더");

  let gone = 0;
  const stop = watchDirectory(dir, () => gone++, { intervalMs: 20 });
  await sleep(80);
  expect(gone === 0, "폴더가 있는 동안은 부르지 않는다");
  rmSync(dir, { recursive: true });
  await sleep(120);
  expect(gone === 1, `지워지면 한 번만 부른다: ${gone}`);
  mkdirSync(dir);
  await sleep(80);
  expect(gone === 1, "다시 생겨도 감시는 이미 끝났다(다음 전송이 새로 검사한다)");
  stop();

  // 멈춘 감시는 지워져도 부르지 않는다
  let late = 0;
  const stopped = watchDirectory(dir, () => late++, { intervalMs: 20 });
  stopped();
  rmSync(dir, { recursive: true });
  await sleep(80);
  expect(late === 0, "멈춘 감시는 부르지 않는다");

  // 파일이 폴더 자리를 차지해도 사라진 것으로 본다
  let replaced = 0;
  const file = join(root, "was-dir");
  mkdirSync(file);
  const stopReplaced = watchDirectory(file, () => replaced++, { intervalMs: 20 });
  rmSync(file, { recursive: true });
  await sleep(100);
  stopReplaced();
  expect(replaced === 1, "폴더가 사라지면 호출");
  console.log("ok   작업 폴더 감시");
} finally {
  rmSync(root, { recursive: true, force: true });
}
