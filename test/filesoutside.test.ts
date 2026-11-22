import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFileWithStat, writeWorkspaceFile } from "../server/files";

const base = mkdtempSync("/tmp/agent-nav-outside-");
const fail: string[] = [];
const expect = (cond: boolean, msg: string) => cond || fail.push(msg);
try {
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "in.txt"), "in");
  const outsideDir = join(base, "elsewhere");
  mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, "report.html"), "<p>hi</p>");

  const inside = await readWorkspaceFileWithStat(workspace, "in.txt");
  expect(inside.text === "in" && inside.readOnly === false, "작업 폴더 안은 그대로 읽고 쓸 수 있다");

  const outside = await readWorkspaceFileWithStat(workspace, join(outsideDir, "report.html"));
  expect(outside.text === "<p>hi</p>" && outside.readOnly === true, `/tmp 아래 밖 파일은 읽기 전용으로 연다: ${JSON.stringify(outside)}`);

  const rejected = async (path: string) => readWorkspaceFileWithStat(workspace, path).then(() => false, () => true);
  expect(await rejected(join(homedir(), ".ssh", "config")), "~/.ssh 는 거절");
  expect(await rejected(join(homedir(), ".agent-nav", "token")), "Lodestar 토큰은 거절");
  expect(await rejected("/etc/hosts"), "홈과 /tmp 밖은 거절");
  expect(await rejected(outsideDir), "폴더는 거절");

  const writeRejected = await writeWorkspaceFile(workspace, join(outsideDir, "report.html"), "x").then(() => false, () => true);
  expect(writeRejected, "밖 파일 쓰기는 그대로 거절");
} finally {
  rmSync(base, { recursive: true, force: true });
}
if (fail.length) {
  console.log(fail.map((f) => `FAIL ${f}`).join("\n"));
  process.exit(1);
}
console.log("filesoutside: 7 passed");
