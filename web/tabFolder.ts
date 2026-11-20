import type { Agent } from "../shared/protocol";

// 에디터 탭은 세션이 아니라 워크스페이스(메인 체크아웃)에 속한다. 워크트리 세션으로 옮겨도 남은 탭은 메인 체크아웃의 파일을 보이므로,
// 지금 세션의 작업 저장소 밖 파일이면 그 폴더를 알려 준다. 순수 함수라 test/tabfolder.test.ts 가 시험한다.

export function resolveInWorkspace(workspaceDir: string, path: string) {
  if (path.startsWith("/")) return path;
  const parts = workspaceDir.split("/");
  for (const segment of path.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

// 지금 세션의 저장소(모르면 작업 폴더) 밖에 있는 파일이면 그 파일이 있는 워크스페이스 폴더, 아니면 null. 폴더 없는 세션과 새 세션 화면은 비교 대상이 없다.
export function foreignFolder(workspaceDir: string | undefined, path: string | null, agent: Pick<Agent, "cwd" | "workspaceId"> | undefined, repoRoot: string | null | undefined): { folder: string; file: string; session: string } | null {
  if (!workspaceDir || path === null || !agent || agent.workspaceId === null) return null;
  const session = repoRoot ?? agent.cwd;
  const file = resolveInWorkspace(workspaceDir, path);
  if (file === session || file.startsWith(`${session}/`) || file.startsWith(`${agent.cwd}/`)) return null;
  return { folder: workspaceDir, file, session: agent.cwd };
}
