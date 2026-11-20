// PR diff 의 언어 기능(hover, 정의 이동)이 쓰는 로직을 확인한다: 어느 로컬 폴더의 글을 쓸지 고르기(체크아웃 판정), 저장소 매칭, git show 로 읽기,
// 정의 이동 결과를 PR diff 안으로 보낼지 판정, 글자 위치 도구, 가상 문서가 실제 보기에 밀려나는 규칙. GitHub 에는 닿지 않는다(가짜 gh).
// 실행: npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import type { LSPClient } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { chooseLocalTarget, isRepoRelativePath, isSha, relPathIn, resolveDefinitionTarget, sameCodeLine, wordRangeAt, type PrLocalCandidate } from "../shared/prLsp";
import type { PrFile } from "../shared/prTypes";
import { prHandlers } from "../server/pr";
import { NavWorkspace } from "../web/lspWorkspace";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "agent-nav-prlsp-"));
process.env.PATH = `${resolve(here, "fixtures/pr/bin")}:${process.env.PATH}`;

const cand = (over: Partial<PrLocalCandidate> & { workspaceId: string; dir: string }): PrLocalCandidate => ({ topLevel: true, headSha: "1111111", branch: "main", hasCommit: false, ...over });
const HEAD = "abc1234def5678abc1234def5678abc1234def56";

try {
  // --- 체크아웃 판정 ---
  const input = { headRef: "feature/42", headSha: HEAD, checkoutDir: "/w/repo.worktrees/feature/42" };
  assert.deepEqual(chooseLocalTarget(input, []), { kind: "no-workspace" });
  assert.deepEqual(chooseLocalTarget(input, [cand({ workspaceId: "a", dir: "/w/repo" })]), { kind: "fetch-needed", workspaceId: "a", dir: "/w/repo" }, "커밋이 로컬에 없으면 fetch 가 필요하다");
  assert.deepEqual(chooseLocalTarget(input, [cand({ workspaceId: "a", dir: "/w/repo", hasCommit: true })]), { kind: "commit", workspaceId: "a", dir: "/w/repo" }, "체크아웃은 아니고 커밋이 있다");
  assert.deepEqual(
    chooseLocalTarget(input, [cand({ workspaceId: "a", dir: "/w/repo", branch: "feature/42", headSha: HEAD.toUpperCase(), hasCommit: true })]),
    { kind: "checked-out", workspaceId: "a", dir: "/w/repo", branch: "feature/42", exact: true },
    "HEAD 가 head 커밋이면 대소문자와 무관하게 체크아웃",
  );
  const sameBranchOnly = chooseLocalTarget(input, [cand({ workspaceId: "a", dir: "/w/repo", branch: "feature/42", headSha: "2222222", hasCommit: true })]);
  assert.deepEqual(sameBranchOnly, { kind: "checked-out", workspaceId: "a", dir: "/w/repo", branch: "feature/42", exact: false }, "브랜치만 같고 커밋은 다르다(exact 거짓)");
  const detached = chooseLocalTarget(input, [cand({ workspaceId: "a", dir: "/w/repo", branch: null, headSha: HEAD, hasCommit: true })]);
  assert.deepEqual([detached.kind, "branch" in detached ? detached.branch : "x"], ["checked-out", null], "detached HEAD 도 커밋이 같으면 체크아웃");
  assert.equal(chooseLocalTarget(input, [cand({ workspaceId: "a", dir: "/w/repo", branch: "other" })]).kind, "fetch-needed", "다른 브랜치만 체크아웃된 폴더는 체크아웃이 아니다");

  // 우선순위: Checkout 이 만든 worktree > 커밋까지 같은 폴더 > 브랜치만 같은 폴더, 같으면 하위 worktree
  const main = cand({ workspaceId: "main", dir: "/w/repo", branch: "feature/42", headSha: HEAD, hasCommit: true });
  const made = cand({ workspaceId: "made", dir: "/w/repo.worktrees/feature/42", topLevel: false, branch: "feature/42", headSha: "2222222", hasCommit: true });
  assert.equal((chooseLocalTarget(input, [main, made]) as { workspaceId: string }).workspaceId, "made", "Checkout 버튼이 만든 worktree 를 먼저 쓴다");
  const other = cand({ workspaceId: "other", dir: "/w/other-tree", topLevel: false, branch: "feature/42", headSha: HEAD, hasCommit: true });
  assert.equal((chooseLocalTarget({ ...input, checkoutDir: null }, [main, other]) as { workspaceId: string }).workspaceId, "other", "점수가 같으면 하위 worktree 워크스페이스");
  const lagging = cand({ workspaceId: "lag", dir: "/w/lag", topLevel: false, branch: "feature/42", headSha: "3333333", hasCommit: true });
  assert.equal((chooseLocalTarget({ ...input, checkoutDir: null }, [lagging, main]) as { workspaceId: string }).workspaceId, "main", "커밋까지 같은 폴더가 브랜치만 같은 폴더보다 앞선다");
  // commit 모드는 프로젝트 폴더(node_modules 가 있는 쪽)를 먼저 쓴다
  const tree = cand({ workspaceId: "tree", dir: "/w/repo.worktrees/x", topLevel: false, hasCommit: true });
  const top = cand({ workspaceId: "top", dir: "/w/repo", hasCommit: true });
  assert.equal((chooseLocalTarget(input, [tree, top]) as { workspaceId: string }).workspaceId, "top");

  // --- 작은 순수 함수 ---
  assert.equal(relPathIn("/w/repo", "/w/repo/src/a.ts"), "src/a.ts");
  assert.equal(relPathIn("/w/repo", "/w/repository/src/a.ts"), null, "폴더 이름이 접두사만 같은 다른 폴더");
  assert.equal(relPathIn("/w/repo/", "/w/repo/a.ts"), "a.ts");
  assert.equal(sameCodeLine("const a = 1;", "const a = 1;"), true);
  assert.equal(sameCodeLine("const a = 1;", "const a = 1;\r"), true, "CRLF 파일의 patch 줄 끝 \\r 은 무시");
  assert.equal(sameCodeLine("const a = 1;", "const a = 2;"), false);
  const text = "export const x = getLogger($ref, 한글);";
  const at = (needle: string, delta = 0) => text.indexOf(needle) + delta;
  assert.deepEqual(wordRangeAt(text, at("getLogger", 3)), { from: at("getLogger"), to: at("getLogger") + 9 });
  assert.deepEqual(wordRangeAt(text, at("getLogger")), { from: at("getLogger"), to: at("getLogger") + 9 }, "단어 시작 경계");
  assert.deepEqual(wordRangeAt(text, at("getLogger") + 9), { from: at("getLogger"), to: at("getLogger") + 9 }, "단어 끝 경계는 앞 단어");
  assert.equal(wordRangeAt(text, at(" = ", 1)), null, "공백 가운데는 식별자가 아니다");
  assert.deepEqual(wordRangeAt(text, at("$ref", 1)), { from: at("$ref"), to: at("$ref") + 4 }, "$ 도 식별자 글자");
  assert.deepEqual(wordRangeAt(text, at("한글", 1)), { from: at("한글"), to: at("한글") + 2 }, "한글 식별자");
  assert.equal(wordRangeAt("", 0), null);
  assert.equal(wordRangeAt("a😀b", 3)?.from, 3, "두 단위 글자는 식별자가 아니고 그 뒤 단어가 시작이다");
  assert.equal(isSha("abc1234"), true);
  assert.equal(isSha("abc123"), false);
  assert.equal(isSha("--output=x"), false);
  assert.equal(isRepoRelativePath("src/a.ts"), true);
  for (const bad of ["../a", "a/../b", "/etc/passwd", "-x", "a//b", "", "a\0b"]) assert.equal(isRepoRelativePath(bad), false, `거절: ${JSON.stringify(bad)}`);

  // --- 정의 이동 결과를 PR diff 안으로 보낼지 ---
  const file = (path: string, patch: string | null, status: PrFile["status"] = "modified"): PrFile => ({ path, previousPath: null, status, additions: 0, deletions: 0, patch, viewed: false });
  const files = [
    file("src/greet.ts", "@@ -1,3 +1,4 @@\n a\n-b\n+b2\n+b3\n c"),
    file("src/gone.ts", "@@ -1 +0,0 @@\n-x", "removed"),
    file("docs/logo.png", null, "added"),
  ];
  assert.deepEqual(resolveDefinitionTarget(files, "src/greet.ts", 2), { kind: "pr", path: "src/greet.ts", row: 4, line: 3 }, "0부터 센 줄 2 는 새 쪽 3번째 줄(추가 줄 b3)");
  assert.deepEqual(resolveDefinitionTarget(files, "src/greet.ts", 0), { kind: "pr", path: "src/greet.ts", row: 1, line: 1 });
  assert.deepEqual(resolveDefinitionTarget(files, "src/greet.ts", 40), { kind: "local" }, "hunk 밖의 줄은 로컬 파일");
  assert.deepEqual(resolveDefinitionTarget(files, "src/other.ts", 0), { kind: "local" }, "PR 이 바꾸지 않은 파일");
  assert.deepEqual(resolveDefinitionTarget(files, "src/gone.ts", 0), { kind: "local" }, "삭제된 파일");
  assert.deepEqual(resolveDefinitionTarget(files, "docs/logo.png", 0), { kind: "local" }, "patch 가 없는 파일");
  assert.deepEqual(resolveDefinitionTarget(files, null, 0), { kind: "local" }, "워크스페이스 밖");

  // --- 데몬: pr.local, pr.fileAt (임시 저장소 + 로컬 bare 원격) ---
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  const bare = join(tmp, "origin.git");
  run(tmp, "init", "-q", "--bare", "-b", "main", bare);
  const repo = realpathSync(mkdtempSync(join(tmp, "repo-")));
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "init");
  run(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  run(repo, "config", `url.${bare}.insteadOf`, "https://github.com/acme/widgets.git");
  run(repo, "push", "-q", "origin", "main");
  run(repo, "checkout", "-q", "-b", "feature/42");
  writeFileSync(join(repo, "b.txt"), "two\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "feature");
  run(repo, "push", "-q", "origin", "feature/42");
  const headSha = run(repo, "rev-parse", "HEAD");
  run(repo, "checkout", "-q", "main");

  const workspaces: { id: string; name: string; dir: string; parentId: string | null; feedback?: boolean }[] = [{ id: "ws-1", name: "widgets", dir: repo, parentId: null }];
  const handlers = prHandlers({
    workspaces: () => workspaces as never,
    addWorkspace: (dir, parentId, name) => {
      const w = { id: `ws-${workspaces.length + 1}`, name, dir, parentId };
      workspaces.push(w);
      return w as never;
    },
    workspaceOfDir: (dir) => workspaces.find((w) => w.dir === dir) as never,
    announce: () => undefined,
  });
  const ref = { repo: "acme/widgets", number: 42, headRef: "feature/42", headSha };

  assert.deepEqual(await handlers["pr.local"](ref), { kind: "commit", workspaceId: "ws-1", dir: repo }, "브랜치는 있지만 체크아웃되지 않았다: 커밋 모드");
  assert.deepEqual(await handlers["pr.local"]({ ...ref, repo: "acme/other" }), { kind: "no-workspace" }, "이 저장소를 가리키는 원격이 없다");
  const missing = "1234567890abcdef1234567890abcdef12345678";
  assert.deepEqual(await handlers["pr.local"]({ ...ref, headRef: "feature/gone", headSha: missing }), { kind: "fetch-needed", workspaceId: "ws-1", dir: repo }, "로컬 git 에 커밋이 없다");
  await assert.rejects(handlers["pr.local"]({ ...ref, headSha: "--upload-pack=x" }), /Not a commit id/);
  await assert.rejects(handlers["pr.local"]({ ...ref, repo: "not a repo" }), /Not a GitHub repository/);
  workspaces.push({ id: "ws-fb", name: "feedback", dir: repo, parentId: null, feedback: true });
  assert.equal((await handlers["pr.local"](ref)).kind, "commit", "피드백 워크스페이스는 후보가 아니다");
  workspaces.pop();

  // 읽기: sha 시점의 파일 글
  assert.deepEqual(await handlers["pr.fileAt"]({ workspaceId: "ws-1", sha: headSha, path: "b.txt" }), { text: "two\n" }, "작업 폴더는 main 이라 b.txt 가 없어도 head 커밋의 글을 읽는다");
  assert.deepEqual(await handlers["pr.fileAt"]({ workspaceId: "ws-1", sha: headSha, path: "nope.txt" }), { text: null }, "그 커밋에 없는 파일");
  for (const bad of ["../a.txt", "-x", "/etc/passwd", "a//b"]) await assert.rejects(handlers["pr.fileAt"]({ workspaceId: "ws-1", sha: headSha, path: bad }), /Not a repository path/, bad);
  await assert.rejects(handlers["pr.fileAt"]({ workspaceId: "ws-1", sha: "main", path: "a.txt" }), /Not a commit id/, "브랜치 이름이나 옵션은 sha 가 아니다");
  await assert.rejects(handlers["pr.fileAt"]({ workspaceId: "nope", sha: headSha, path: "a.txt" }), /Unknown workspace/);

  // 프로젝트 폴더가 PR 브랜치를 체크아웃하면 체크아웃 모드(커밋까지 같음)
  run(repo, "checkout", "-q", "feature/42");
  assert.deepEqual(await handlers["pr.local"](ref), { kind: "checked-out", workspaceId: "ws-1", dir: repo, branch: "feature/42", exact: true });
  // 로컬 커밋이 앞서가면 브랜치만 같다
  writeFileSync(join(repo, "c.txt"), "three\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "local only");
  const ahead = await handlers["pr.local"](ref);
  assert.deepEqual([ahead.kind, "exact" in ahead ? ahead.exact : null], ["checked-out", false], "로컬 커밋이 앞선 체크아웃은 exact 거짓");
  run(repo, "reset", "-q", "--hard", headSha);
  run(repo, "checkout", "-q", "main");

  // Checkout 버튼이 만든 worktree 워크스페이스(하위)가 있으면 그것을 쓴다
  const checkedOut = await handlers["pr.checkout"]({ confirmed: true, repo: "acme/widgets", number: 42 });
  const local = await handlers["pr.local"](ref);
  assert.deepEqual(local, { kind: "checked-out", workspaceId: checkedOut.workspaceId, dir: checkedOut.dir, branch: "feature/42", exact: true }, "Checkout 으로 만든 worktree 가 우선");
  assert.notEqual(checkedOut.workspaceId, "ws-1");
  // worktree 가 사라지면 다시 커밋 모드
  workspaces.splice(1);
  run(repo, "worktree", "remove", "--force", checkedOut.dir);
  assert.equal((await handlers["pr.local"](ref)).kind, "commit");

  // --- NavWorkspace: 가상 문서는 같은 URI 를 실제 보기가 열면 밀려난다 ---
  const calls: string[] = [];
  const client = { didOpen: (f: { uri: string }) => calls.push(`didOpen ${f.uri}`), didClose: (uri: string) => calls.push(`didClose ${uri}`) } as unknown as LSPClient;
  const workspace = new NavWorkspace(client, async () => {
    throw new Error("not used");
  });
  const view = (doc: string) => ({ state: EditorState.create({ doc }) }) as unknown as EditorView;
  const URI = "file:///repo/src/a.ts";
  const prView = view("head text");
  workspace.openFile(URI, "typescript", prView);
  let evicted = 0;
  workspace.markVirtual(URI, () => evicted++);
  assert.equal(workspace.isVirtual(URI), true);
  assert.deepEqual(calls, [`didOpen ${URI}`]);
  const tab = view("disk text");
  workspace.openFile(URI, "typescript", tab);
  assert.deepEqual(calls, [`didOpen ${URI}`, `didClose ${URI}`, `didOpen ${URI}`], "가상 문서를 닫고 탭이 새로 연다");
  assert.equal(evicted, 1, "가상 문서의 주인에게 알린다");
  assert.deepEqual(workspace.viewsOf(URI), [tab], "밀려난 보기는 목록에 없다");
  assert.equal(workspace.isVirtual(URI), false);
  assert.equal(workspace.getFile(URI)?.doc.toString(), "disk text", "서버 글은 탭의 글이다");
  workspace.closeFile(URI, prView);
  assert.deepEqual(workspace.viewsOf(URI), [tab], "밀려난 보기를 닫아도 탭의 문서는 그대로");
  assert.equal(calls.length, 3);
  workspace.closeFile(URI, tab);
  assert.equal(calls.at(-1), `didClose ${URI}`);
  // 가상 문서끼리는 서로 밀어내지 않고, 정상으로 닫으면 표시도 지워진다
  workspace.openFile(URI, "typescript", prView);
  workspace.markVirtual(URI, () => evicted++);
  workspace.closeFile(URI, prView);
  assert.equal(workspace.isVirtual(URI), false);
  assert.equal(evicted, 1);

  console.log("prlsp: 모든 확인 통과");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
