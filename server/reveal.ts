import { execFile } from "node:child_process";
import { dirname } from "node:path";

export function revealCommand(dir: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: ["-R", dir] };
  if (platform === "win32") return { file: "explorer", args: [`/select,${dir}`] };
  return { file: "xdg-open", args: [dirname(dir)] };
}

export function revealInFileManager(dir: string) {
  const { file, args } = revealCommand(dir);
  return new Promise<void>((resolve, reject) => execFile(file, args, (error) => (error ? reject(error) : resolve())));
}

export function openCommand(path: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: [path] };
  if (platform === "win32") return { file: "explorer", args: [path] };
  return { file: "xdg-open", args: [path] };
}

export function openWithDefaultApp(path: string) {
  const { file, args } = openCommand(path);
  return new Promise<void>((resolve, reject) => execFile(file, args, (error) => (error ? reject(error) : resolve())));
}
