import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 앱 코드를 이루는 소스의 지문: "가장 최근 수정 시각(ms):파일 수". 빌드 때 dist-electron/build-stamp.json 에 같은 값을 적어 두고, 설치된 앱의 값과 견주어 새 소스가 있는지 본다.
// 파일 목록은 git 이 알려 준다(추적 중이거나 새로 만든 것, .gitignore 제외). 파일이 지워져도 수가 달라진다.
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
          // 목록에는 있지만 이미 지워진 파일
        }
      }),
    );
    return count === 0 ? null : { stamp: `${Math.floor(newest)}:${count}`, changedAt: newest };
  } catch {
    return null;
  }
}
