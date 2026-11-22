import { foreignFolder, resolveInWorkspace } from "../web/tabFolder";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const main = "/w/practice";
const worktree = "/w/practice.worktrees/feature/x";

expect(resolveInWorkspace(main, "src/a.ts") === "/w/practice/src/a.ts", "relative");
expect(resolveInWorkspace(main, "../practice.worktrees/feature/x/a.ts") === `${worktree}/a.ts`, "parent segments");
expect(foreignFolder(main, "src/a.ts", { cwd: main, workspaceId: "w" }, main) === null, "same checkout is not foreign");
expect(foreignFolder(main, "src/a.ts", { cwd: worktree, workspaceId: "w" }, worktree)?.folder === main, "main file in a worktree session is foreign");
expect(foreignFolder(main, "../practice.worktrees/feature/x/a.ts", { cwd: worktree, workspaceId: "w" }, worktree) === null, "the session's own worktree file is not foreign");
expect(foreignFolder(main, "src/a.ts", { cwd: `${main}/pkg`, workspaceId: "w" }, main) === null, "monorepo sub folder session shares the repo");
expect(foreignFolder(main, "src/a.ts", { cwd: "/tmp/chat", workspaceId: null }, null) === null, "chat sessions have no folder");
expect(foreignFolder(main, "src/a.ts", undefined, null) === null, "no session");
console.log("ok  tabfolder");
