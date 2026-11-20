import { execFile } from "node:child_process";
import { dirname } from "node:path";

// WSMENU: 폴더를 파일 관리자에서 보여 준다. macOS 는 부모 폴더에서 그 폴더를 고른 채 Finder 를 연다(탐색기의 Reveal in Finder 와 같다).
export function revealCommand(dir: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: ["-R", dir] };
  if (platform === "win32") return { file: "explorer", args: [`/select,${dir}`] };
  return { file: "xdg-open", args: [dirname(dir)] };
}

export function revealInFileManager(dir: string) {
  const { file, args } = revealCommand(dir);
  return new Promise<void>((resolve, reject) => execFile(file, args, (error) => (error ? reject(error) : resolve())));
}
