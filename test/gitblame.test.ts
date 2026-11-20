// 커서 줄 blame: git blame --porcelain 풀이(server/gitBlame.ts)와 줄 끝 주석, 상태 표시줄 문구(web/gitBlameModel.ts)를 임시 저장소로 확인한다. 데몬도 화면도 필요 없다.
// 저장소: 작성자 둘(alice 가 user.email, bob), 커밋 둘, 커밋 안 된 줄 하나.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";

const home = mkdtempSync(join(tmpdir(), "agent-nav-blame-home-"));
process.env.AGENT_NAV_HOME = home;
// 사용자 git 설정을 읽지 않는다. 전역 core.autocrlf=input 이면 CRLF 파일이 LF 로 커밋돼 아래 CRLF 확인이 기기마다 달라진다.
process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
const { blameOf, parseBlame } = await import("../server/gitBlame");
const { absoluteDate, agoText, commitAtCursor, inlineText, shortHash, statusTitle, whoWhen } = await import("../web/gitBlameModel");

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const same = (name: string, got: unknown, want: unknown) => expect(JSON.stringify(got) === JSON.stringify(want), `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const dirs: string[] = [home];
const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-blame-")));
dirs.push(repo);
const plain = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-blame-plain-")));
dirs.push(plain);

const AT_ALICE = "2026-01-01T00:00:00+0000";
const AT_BOB = "2026-01-05T00:00:00+0000";
const run = (cwd: string, args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...env } }).toString();
const commit = (message: string, who: "alice" | "bob", date: string) => {
  run(repo, ["add", "-A"]);
  const env = { GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@example.com`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@example.com`, GIT_COMMITTER_DATE: date };
  run(repo, ["commit", "-q", "-m", message], env);
};

try {
  run(repo, ["init", "-q", "-b", "main"]);
  run(repo, ["config", "user.email", "alice@example.com"]);
  run(repo, ["config", "user.name", "alice"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/greet.ts"), "line one\nline two\nline three\n");
  commit("Add greet", "alice", AT_ALICE);
  // bob 이 둘째 줄을 고치고 맨 끝에 한 줄을 더한다. 메시지는 여러 줄이다.
  writeFileSync(join(repo, "src/greet.ts"), "line one\nline two edited\nline three\nline four\n");
  commit("Add loud option\n\nShout when asked.\nSecond paragraph line.", "bob", AT_BOB);
  // 커밋 안 된 줄: 셋째 줄을 고쳤다
  writeFileSync(join(repo, "src/greet.ts"), "line one\nline two edited\nline three local\nline four\n");

  // 저장된 파일 기준
  const blame = await blameOf(repo, "src/greet.ts");
  expect(blame !== null, "추적하는 파일은 blame 이 있다");
  const at = (line: number) => blame!.commits[blame!.lines[line - 1]!]!;
  same("줄 수", blame!.lines.length, 4);
  same("1줄 작성자", [at(1).author, at(1).email, at(1).you, at(1).uncommitted, at(1).summary], ["alice", "alice@example.com", true, false, "Add greet"]);
  same("2줄 작성자", [at(2).author, at(2).you, at(2).summary], ["bob", false, "Add loud option"]);
  same("2줄 메시지 전문", at(2).message, "Add loud option\n\nShout when asked.\nSecond paragraph line.");
  same("3줄은 커밋 안 된 줄", [at(3).uncommitted, at(3).you, at(3).hash.replace(/0/g, "")], [true, true, ""]);
  same("4줄 작성자", at(4).author, "bob");
  same("같은 커밋은 하나로 모은다", blame!.commits.length, 3);
  same("작성 시각(초)", [at(1).time, at(2).time], [Date.parse(AT_ALICE) / 1000, Date.parse(AT_BOB) / 1000]);
  expect(at(1).hash.length === 40, "해시는 전체 길이");

  // 저장 안 한 버퍼(맨 위에 한 줄 끼움)를 넘기면 줄 번호가 그 버퍼에 맞고, 끼운 줄은 커밋 안 된 줄이다
  const buffer = "inserted top\nline one\nline two edited\nline three local\nline four\n";
  const shifted = await blameOf(repo, "src/greet.ts", buffer);
  const shiftedAt = (line: number) => shifted!.commits[shifted!.lines[line - 1]!]!;
  same("버퍼 줄 수", shifted!.lines.length, 5);
  same("끼운 줄", [shiftedAt(1).uncommitted, shiftedAt(1).you], [true, true]);
  same("밀린 1줄 원래 작성자", shiftedAt(2).author, "alice");
  same("밀린 2줄 원래 작성자", shiftedAt(3).author, "bob");
  same("밀린 4줄은 여전히 커밋 안 된 줄", shiftedAt(4).uncommitted, true);

  // 저장 내용과 같은 버퍼는 저장된 파일과 같은 결과다
  const lf = await blameOf(repo, "src/greet.ts", "line one\nline two edited\nline three local\nline four\n");
  // 커밋 안 된 줄의 author 문구는 git 이 경로에 따라 다르게 낸다(Not Committed Yet, External file (--contents)). 그래서 커밋 안 됨 표시와 커밋 작성자로 비교한다.
  const who = (b: NonNullable<typeof blame>) => b.lines.map((i) => (b.commits[i]!.uncommitted ? "(uncommitted)" : b.commits[i]!.author));
  same("저장 내용과 같은 버퍼는 저장된 파일과 같은 결과", who(lf!), who(blame!));

  // 같은 입력은 캐시에서 같은 객체가 나온다
  same("캐시", (await blameOf(repo, "src/greet.ts")) === blame, true);

  // 추적 안 하는 파일, 저장소가 아닌 폴더, 없는 파일은 오류가 아니라 null
  writeFileSync(join(repo, "untracked.txt"), "x\n");
  same("추적 안 하는 파일", await blameOf(repo, "untracked.txt"), null);
  writeFileSync(join(plain, "a.txt"), "x\n");
  same("저장소가 아닌 폴더", await blameOf(plain, "a.txt"), null);
  same("없는 파일", await blameOf(repo, "nope.ts").catch(() => null), null);
  // 작업 폴더와 저장소 밖 경로는 거절한다
  let rejected = false;
  await blameOf(repo, join(plain, "a.txt")).catch(() => (rejected = true));
  expect(rejected, "저장소 밖 경로는 거절");
  // CRLF 파일: 화면이 문서의 줄끝으로 이어 붙여 보내면 줄이 어긋나지 않고, LF 로 보내면 모든 줄이 바뀐 줄이 된다(그래서 화면은 state.lineBreak 로 보낸다)
  writeFileSync(join(repo, "crlf.txt"), "a\r\nb\r\n");
  commit("Add crlf", "bob", AT_BOB);
  same("CRLF 버퍼", (await blameOf(repo, "crlf.txt", "a\r\nb\r\n"))?.commits.map((c) => c.uncommitted), [false]);
  same("LF 로 바꿔 보내면", (await blameOf(repo, "crlf.txt", "a\nb\n"))?.commits.map((c) => c.uncommitted), [true]);
  // 파일 이름이 -로 시작해도 옵션으로 읽히지 않는다
  writeFileSync(join(repo, "--help"), "x\n");
  commit("Add dash file", "bob", AT_BOB);
  same("-로 시작하는 이름", (await blameOf(repo, "--help"))?.lines.length, 1);

  // 풀이 함수: 묶음 머리글(같은 커밋 연속 줄)은 메타데이터 없이 와도 줄마다 채운다
  const sample = [
    "1111111111111111111111111111111111111111 1 1 2",
    "author Zed",
    "author-mail <zed@example.com>",
    "author-time 100",
    "summary First",
    "filename f",
    "\tone",
    "1111111111111111111111111111111111111111 2 2",
    "\ttwo",
    "0000000000000000000000000000000000000000 3 3 1",
    "author Not Committed Yet",
    "author-mail <not.committed.yet>",
    "author-time 200",
    "summary Version of f from f",
    "filename f",
    "\tthree",
    "",
  ].join("\n");
  const parsed = parseBlame(sample);
  same("풀이 줄", parsed.lines, [0, 0, 1]);
  same("풀이 커밋", parsed.commits.map((c) => [c.author, c.email, c.time, c.summary, c.uncommitted]), [["Zed", "zed@example.com", 100, "First", false], ["Not Committed Yet", "not.committed.yet", 200, "Version of f from f", true]]);
  same("빈 출력", parseBlame(""), { commits: [], lines: [] });

  // 문구: 줄 끝 주석, 상태 표시줄, 카드 날짜
  const now = at(2).time * 1000 + 21 * 24 * 3600 * 1000;
  same("줄 끝 주석", inlineText(at(2), now), "bob, 3 weeks ago • Add loud option");
  same("내 커밋은 You", whoWhen(at(1), now), "You, 4 weeks ago");
  same("커밋 안 된 줄", inlineText(at(3), now), "You, now • Uncommitted changes");
  same("커밋 안 된 줄 시간", agoText(at(3), now), "now");
  const longSummary = { ...at(2), summary: "x".repeat(100) };
  same("긴 제목은 잘린다", inlineText(longSummary, now).length, "bob, 3 weeks ago • ".length + 80);
  expect(/2026/.test(absoluteDate(at(2))), "절대 날짜에 연도");
  same("커밋 안 된 줄은 날짜 없음", absoluteDate(at(3)), "");
  same("짧은 해시", shortHash(at(2)), at(2).hash.slice(0, 7));
  expect(statusTitle(at(2)).startsWith(`${shortHash(at(2))} Add loud option`), "상태 표시줄 툴팁은 해시와 제목으로 시작");

  // 커서 줄 선택: head 줄, 여러 줄 선택이어도 head 하나, 문서가 다르면 null
  const text = "line one\nline two edited\nline three local\nline four\n";
  const state = (selection: { anchor: number; head?: number }) => EditorState.create({ doc: text, selection });
  const data = { doc: state({ anchor: 0 }).doc, blame: blame! };
  same("커서 1줄", commitAtCursor(data, state({ anchor: 3 }))?.author, "alice");
  same("커서 2줄", commitAtCursor(data, state({ anchor: text.indexOf("two") }))?.author, "bob");
  same("여러 줄 선택은 head 줄", commitAtCursor(data, state({ anchor: 0, head: text.indexOf("four") }))?.author, "bob");
  same("여러 줄 선택(거꾸로)은 head 줄", commitAtCursor(data, state({ anchor: text.indexOf("four"), head: 0 }))?.author, "alice");
  same("커밋 안 된 줄", commitAtCursor(data, state({ anchor: text.indexOf("three") }))?.uncommitted, true);
  const edited = EditorState.create({ doc: text.replace("one", "ONE"), selection: { anchor: 0 } });
  same("문서가 바뀌면 표시 없음", commitAtCursor(data, edited), null);
  same("blame 이 없으면 표시 없음", commitAtCursor(null, state({ anchor: 0 })), null);
  const trailing = state({ anchor: text.length });
  same("마지막 빈 줄(줄 정보 없음)", commitAtCursor(data, trailing), null);

  console.log("gitblame: ok");
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
