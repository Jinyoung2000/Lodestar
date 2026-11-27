import { router } from "expo-router";
import { diag } from "../state/diagLog";

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  if (initial || !opensHome(path)) return path;
  diag(`link to home while running: ${router.canDismiss() ? "closing the screens above it" : "already home"}`);
  if (router.canDismiss()) router.dismissAll();
  return null;
}

function opensHome(path: string): boolean {
  const rest = path.replace(/^lodestar:\/\//, "").replace(/[?#].*$/, "");
  return rest === "" || rest === "/";
}
