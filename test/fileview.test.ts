import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readWorkspaceBinary, readWorkspaceFileWithStat, saveWorkspaceFile } from "../server/files";
import { copyName, fitScale, formatBytes, isImagePath, stepZoom } from "../web/fileKind";

const cases: { name: string; run: () => Promise<string> | string }[] = [];
const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-fileview-")));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
writeFileSync(join(base, "text.txt"), "hello\n");
writeFileSync(join(base, "blob.bin"), Buffer.from([0, 1, 2, 3, 255]));
writeFileSync(join(base, "pic.png"), Buffer.from([137, 80, 78, 71, 0, 0, 0]));
writeFileSync(join(base, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
writeFileSync(join(base, "ro.txt"), "locked\n");
chmodSync(join(base, "ro.txt"), 0o444);

test("files.read reports binary files without sending their bytes as text", async () => {
  const blob = await readWorkspaceFileWithStat(base, "blob.bin");
  expect("binary" in blob && blob.binary === true && blob.text === "" && blob.size === 5, JSON.stringify(blob));
  const big = await readWorkspaceFileWithStat(base, "big.bin");
  expect("binary" in big && big.binary === true && big.size === 3 * 1024 * 1024, "large binary");
  const text = await readWorkspaceFileWithStat(base, "text.txt");
  return expect(text.text === "hello\n" && !("binary" in text), "text file unchanged");
});

test("files.read marks files the daemon cannot write", async () => {
  const locked = await readWorkspaceFileWithStat(base, "ro.txt");
  const open = await readWorkspaceFileWithStat(base, "text.txt");
  return expect("readOnly" in locked && locked.readOnly === true && "readOnly" in open && open.readOnly === false, `${JSON.stringify(locked)} ${JSON.stringify(open)}`);
});

test("saving a read-only file answers readonly instead of throwing EACCES", async () => {
  const result = await saveWorkspaceFile(base, "ro.txt", "changed\n", null, true);
  return expect(!result.saved && result.conflict === "readonly", JSON.stringify(result));
});

test("files.readBinary gives base64 and the mime of images", async () => {
  const image = await readWorkspaceBinary(base, "pic.png");
  expect(image.mime === "image/png" && image.size === 7 && image.base64 === Buffer.from([137, 80, 78, 71, 0, 0, 0]).toString("base64"), JSON.stringify(image));
  const other = await readWorkspaceBinary(base, "blob.bin");
  return expect(other.mime === null, "non-image has no mime");
});

test("image paths and zoom steps", () => {
  expect(["a.png", "dir/B.JPG", "x.jpeg", "y.gif", "z.webp", "w.svg"].every(isImagePath), "image extensions");
  expect(!isImagePath("a.ts") && !isImagePath("png") && !isImagePath(null) && !isImagePath("dir.png/readme"), "non-images");
  expect(stepZoom(1, 1) === 1.5 && stepZoom(1, -1) === 0.75 && stepZoom(0.37, 1) === 0.5 && stepZoom(0.37, -1) === 0.25, "steps");
  expect(stepZoom(8, 1) === 8 && stepZoom(0.1, -1) === 0.1, "ends");
  expect(fitScale({ width: 300, height: 180 }, { width: 1000, height: 800 }) === 1, "small stays actual size");
  expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 800 }) === 0.5, "large shrinks");
  return expect(formatBytes(1621) === "1.6 KB" && formatBytes(433 * 1024) === "433 KB" && formatBytes(3 * 1024 * 1024) === "3.0 MB" && formatBytes(5) === "5 B", "bytes");
});

test("Save As default name puts copy before the extension", () => {
  const cases: [string, string][] = [
    ["readonly.txt", "readonly copy.txt"],
    ["src/a/readme.md", "src/a/readme copy.md"],
    ["Makefile", "Makefile copy"],
    [".env", ".env copy"],
    ["config/.env", "config/.env copy"],
    [".config.json", ".config copy.json"],
    ["a.test.ts", "a.test copy.ts"],
    ["dir.v2/name", "dir.v2/name copy"],
    ["trailing.", "trailing. copy"],
  ];
  for (const [input, expected] of cases) expect(copyName(input) === expected, `${input} -> ${copyName(input)} (want ${expected})`);
  return `${cases.length} names`;
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok  ${c.name} - ${await c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}\n  ${(error as Error).message}`);
  }
}
rmSync(base, { recursive: true, force: true });
if (failed) process.exit(1);
