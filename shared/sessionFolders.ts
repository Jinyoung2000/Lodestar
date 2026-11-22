import type { Workspace } from "./protocol";

const isUnder = (root: string, path: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

export function folderOf(roots: readonly string[], path: string): string | null {
  let best: string | null = null;
  for (const root of roots) if (isUnder(root, path) && (best === null || root.length > best.length)) best = root;
  return best;
}

const parentOf = (dir: string) => {
  const cut = dir.replace(/\/+$/, "").lastIndexOf("/");
  return cut > 0 ? dir.slice(0, cut) : null;
};

export function projectsParent(workspaces: readonly Pick<Workspace, "dir" | "parentId" | "feedback" | "archived">[], home: string): string {
  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    if (workspace.parentId || workspace.feedback || workspace.archived) continue;
    const parent = parentOf(workspace.dir);
    if (parent && parent !== home && isUnder(home, parent)) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [parent, count] of counts) if (count >= 2 && (best === null || count > counts.get(best)!)) best = parent;
  return best ?? `${home.replace(/\/+$/, "")}/Repository`;
}

export function chatFolderGuidance(options: { parent: string; command: string; sessionId?: string }): string {
  const move = options.sessionId ? `LODESTAR_SESSION_ID=${options.sessionId} ${options.command} session move <folder>` : `${options.command} session move <folder>`;
  return [
    "This Lodestar chat has no project folder yet.",
    `If the user asks you to start or create a project, make a new folder for it under ${options.parent} (for example ${options.parent}/<project-name>; ask if the name is unclear), then run \`${move}\` in the shell.`,
    "That moves this conversation into the folder: from the user's next message on, the session runs there with this conversation carried over. For the rest of the current reply, use absolute paths inside the new folder, and tell the user the chat moved.",
  ].join(" ");
}
