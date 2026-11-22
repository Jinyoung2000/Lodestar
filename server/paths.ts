import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function realDir(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function realPathLoose(path: string) {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}
