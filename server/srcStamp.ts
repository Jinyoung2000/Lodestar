import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PATHS = ["web", "server", "shared", "electron", "scripts", "public", "index.html", "package.json", "vite.config.ts", "tsconfig.json"];

export async function srcStamp(root: string): Promise<{ stamp: string; changedAt: number } | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...PATHS], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const files = stdout.split("\0").filter(Boolean);
    let newest = 0;
    let count = 0;
    await Promise.all(
      files.map(async (file) => {
        try {
          const info = await stat(join(root, file));
          count++;
          if (info.mtimeMs > newest) newest = info.mtimeMs;
        } catch {
        }
      }),
    );
    return count === 0 ? null : { stamp: `${Math.floor(newest)}:${count}`, changedAt: newest };
  } catch {
    return null;
  }
}
