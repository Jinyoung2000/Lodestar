// git 저장소가 아닌 폴더의 파일 목록(server/files.ts walkFolder, listFiles, listEmptyDirs) 시험. 실행: npm test
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEmptyDirs, listFiles } from "../server/files";

const base = mkdtempSync(join(tmpdir(), "agent-nav-walk-"));
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

try {
  // ~/.claude/skills 와 같은 모양: 실제 내용은 다른 곳에 있고 목록 폴더에는 심볼릭 링크만 있다
  const real = join(base, "real");
  const skills = join(base, "skills");
  mkdirSync(join(real, "alpha", "refs"), { recursive: true });
  writeFileSync(join(real, "alpha", "SKILL.md"), "a");
  writeFileSync(join(real, "alpha", "refs", "note.md"), "n");
  mkdirSync(join(skills, "empty"), { recursive: true });
  mkdirSync(join(skills, "node_modules", "x"), { recursive: true });
  writeFileSync(join(skills, "node_modules", "x", "index.js"), "");
  writeFileSync(join(skills, ".DS_Store"), "");
  writeFileSync(join(skills, "README.md"), "r");
  symlinkSync(join(real, "alpha"), join(skills, "alpha"));
  // 같은 실제 폴더를 가리키는 두 번째 링크와 자기 자신을 가리키는 고리
  symlinkSync(join(real, "alpha"), join(skills, "alpha-again"));
  symlinkSync(skills, join(skills, "loop"));

  const files = await listFiles(skills);
  expect(JSON.stringify([...files].sort()) === JSON.stringify(["README.md", "alpha/SKILL.md", "alpha/refs/note.md"]), `files: ${JSON.stringify(files)}`);
  const empty = await listEmptyDirs(skills);
  expect(JSON.stringify(empty) === JSON.stringify(["empty"]), `empty dirs: ${JSON.stringify(empty)}`);
  console.log("walkfolder: 모든 확인 통과");
} finally {
  rmSync(base, { recursive: true, force: true });
}
