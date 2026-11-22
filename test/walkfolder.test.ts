import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEmptyDirs, listFiles } from "../server/files";

const base = mkdtempSync(join(tmpdir(), "agent-nav-walk-"));
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

try {
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
