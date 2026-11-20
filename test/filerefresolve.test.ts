// 대화 속 파일 경로 풀이, 존재 캐시 무효화, 코드 블록 헤더 주석 해석을 확인한다. 데몬도 브라우저도 필요 없다.
// 실행: npm test
import assert from "node:assert/strict";

import { ExistCache } from "../web/fileExistCache";
import { outsideCandidates } from "../web/fileRefOutside";
import { createPathFor, fileIndex, normalizeRelative, resolveFileRef } from "../web/fileRefResolve";
import { codeWithoutPathHeader, forgetSuggestedCode, peekSuggestedCode, rememberSuggestedCode, withTrailingNewline } from "../web/missingFileCode";

const none = new Map<string, boolean>();
const files = ["package.json", "app-cli/package.json", "app-cli/bin/jobs.ts", "app-cli/src/util.ts", "app-webview/src/a.ts", "app-webview/src/Report.tsx", "docs/Report.tsx", "README.md"];
const index = fileIndex(files);

// 정규화
assert.equal(normalizeRelative("./src/a.ts"), "src/a.ts");
assert.equal(normalizeRelative("app-cli/bin/../src/cli.ts"), "app-cli/src/cli.ts");
assert.equal(normalizeRelative("../x.ts"), "../x.ts");
assert.equal(normalizeRelative("a/../../x.ts"), "../x.ts");

// 작업 폴더 기준으로 정확히 맞으면 그것, ./ 는 걷는다
assert.deepEqual(resolveFileRef(index, "app-cli/bin/jobs.ts", [], none), { kind: "found", path: "app-cli/bin/jobs.ts" });
assert.deepEqual(resolveFileRef(index, "./README.md", [], none), { kind: "found", path: "README.md" });

// 접미사가 하나뿐이면 그 파일, 여럿이면 모호함
assert.deepEqual(resolveFileRef(index, "util.ts", [], none), { kind: "found", path: "app-cli/src/util.ts" });
assert.deepEqual(resolveFileRef(index, "Report.tsx", [], none), { kind: "ambiguous", matches: ["app-webview/src/Report.tsx", "docs/Report.tsx"] });
// 여럿이어도 힌트 폴더 아래에 하나뿐이면 그것
assert.deepEqual(resolveFileRef(index, "Report.tsx", ["app-webview/src/a.ts"], none), { kind: "found", path: "app-webview/src/Report.tsx" });

// 힌트 폴더 기준: app-cli/bin/jobs.ts 를 말하는 글의 src/util.ts 는 app-cli/src/util.ts
assert.deepEqual(resolveFileRef(index, "src/util.ts", ["app-cli/bin/jobs.ts"], none), { kind: "found", path: "app-cli/src/util.ts" });
// 작업 폴더 루트에도 있으면 루트가 먼저다
const withRoot = fileIndex([...files, "src/util.ts"]);
assert.deepEqual(resolveFileRef(withRoot, "src/util.ts", ["app-cli/bin/jobs.ts"], none), { kind: "found", path: "src/util.ts" });

// 목록에 없으면 디스크 확인이 필요하다(무시된 파일이나 방금 만든 파일)
const pending = resolveFileRef(index, "src/cli.ts", [], none);
assert.deepEqual(pending, { kind: "pending", check: ["src/cli.ts"] });
assert.deepEqual(resolveFileRef(index, "src/cli.ts", [], new Map([["src/cli.ts", true]])), { kind: "found", path: "src/cli.ts" });
// 확인했는데 없으면 missing. 힌트가 있으면 힌트 폴더 후보까지 모두 확인해야 한다
assert.deepEqual(resolveFileRef(index, "src/cli.ts", [], new Map([["src/cli.ts", false]])), { kind: "missing", path: "src/cli.ts" });
const hinted = resolveFileRef(index, "src/cli.ts", ["app-cli/bin/jobs.ts"], new Map([["src/cli.ts", false]]));
assert.deepEqual(hinted, { kind: "pending", check: ["app-cli/bin/src/cli.ts", "app-cli/src/cli.ts"] });
const settled = resolveFileRef(index, "src/cli.ts", ["app-cli/bin/jobs.ts"], new Map([["src/cli.ts", false], ["app-cli/bin/src/cli.ts", false], ["app-cli/src/cli.ts", false]]));
// 없는 파일은 힌트 파일의 패키지(app-cli/src 가 이미 있다) 아래에 놓일 자리로 보인다
assert.deepEqual(settled, { kind: "missing", path: "app-cli/src/cli.ts" });
// 디스크에서 힌트 폴더 후보가 발견되면 그것
assert.deepEqual(resolveFileRef(index, "src/cli.ts", ["app-cli/bin/jobs.ts"], new Map([["src/cli.ts", false], ["app-cli/bin/src/cli.ts", false], ["app-cli/src/cli.ts", true]])), { kind: "found", path: "app-cli/src/cli.ts" });
// 작업 폴더 밖으로 나가는 경로는 풀지 않고 그대로 둔다
assert.deepEqual(resolveFileRef(index, "../x.ts", [], none), { kind: "found", path: "../x.ts" });

// 놓일 자리: 첫 폴더가 있는 조상, 없으면 package.json 폴더, 힌트가 없으면 루트
assert.equal(createPathFor("src/cli.ts", ["app-cli/bin/jobs.ts"], index), "app-cli/src/cli.ts");
assert.equal(createPathFor("lib/cli.ts", ["app-cli/bin/jobs.ts"], index), "app-cli/lib/cli.ts");
assert.equal(createPathFor("lib/cli.ts", [], index), "lib/cli.ts");
// 루트에 docs/ 가 이미 있으면 힌트 패키지 아래가 아니라 루트 기준이다
assert.equal(createPathFor("docs/new.md", ["app-cli/bin/jobs.ts"], index), "docs/new.md");
assert.equal(createPathFor("lib/cli.ts", ["README.md"], index), "lib/cli.ts");
assert.equal(createPathFor("cli.ts", ["app-cli/bin/jobs.ts"], index), "app-cli/bin/cli.ts");

// 존재 캐시: 목록 배열이 바뀌면 그 폴더 캐시를 버리고 구독자를 깨운다
const cache = new ExistCache();
let woke = 0;
cache.subscribe(() => {
  woke += 1;
});
const list1 = ["a.ts"];
cache.syncList("w1", list1);
cache.set("w1", "x.ts", false);
cache.set("w2", "y.ts", true);
cache.syncList("w1", list1);
assert.equal(cache.known("w1").get("x.ts"), false);
assert.equal(woke, 0);
cache.syncList("w1", ["a.ts", "x.ts"]);
assert.equal(cache.known("w1").has("x.ts"), false);
assert.equal(cache.known("w2").get("y.ts"), true);
assert.equal(woke, 1);
// 버릴 것이 없으면 깨우지 않는다. 폴더를 안 주면 전부 버린다
assert.equal(cache.invalidate("w1"), false);
assert.equal(woke, 1);
assert.equal(cache.invalidate(), true);
assert.equal(cache.known("w2").has("y.ts"), false);
assert.equal(cache.getVersion(), 2);

// 코드 블록 첫 줄이 경로 주석이면 그 줄을 뺀다
assert.equal(codeWithoutPathHeader("// app-cli/src/cli.ts\nexport const a = 1;\n", "app-cli/src/cli.ts"), "export const a = 1;\n");
assert.equal(codeWithoutPathHeader("# src/x.py\nprint(1)", "src/x.py"), "print(1)\n");
assert.equal(codeWithoutPathHeader("/* src/a.css */\n.a{}", "src/a.css"), ".a{}\n");
assert.equal(codeWithoutPathHeader("<!-- docs/a.md -->\n# t", "docs/a.md"), "# t\n");
assert.equal(codeWithoutPathHeader("// src/other.ts\nx", "src/cli.ts"), null);
assert.equal(codeWithoutPathHeader("export const a = 1;", "src/cli.ts"), null);
assert.equal(withTrailingNewline("a"), "a\n");
assert.equal(withTrailingNewline("a\n"), "a\n");

// 제안 코드 저장소
rememberSuggestedCode("w1", "a.ts", "code");
assert.equal(peekSuggestedCode("w1", "a.ts"), "code");
assert.equal(peekSuggestedCode("w2", "a.ts"), null);
forgetSuggestedCode("w1", "a.ts");
assert.equal(peekSuggestedCode("w1", "a.ts"), null);

// 작업 폴더 밖: 같은 대화의 도구 호출이 만진 폴더 기준 후보(app 세션이 app-client 를 읽고 app-webview/... 로 쓴 경우)
{
  const ws = "/Users/me/Repository/app";
  const inputs = [
    JSON.stringify({ command: "cd /Users/me/Repository/app-client/app-webview/src && cat components/pagePromiseReport/schedules.ts | head -80" }),
    JSON.stringify({ file_path: "/Users/me/Repository/app/src/graphql/schema/Schedule/Schedule.ts" }),
  ];
  const got = outsideCandidates("app-webview/src/components/pagePromiseReport/schedules.ts", inputs, ws);
  assert.equal(got[0], "/Users/me/Repository/app-client/app-webview/src/components/pagePromiseReport/schedules.ts");
  // 작업 폴더 안 경로는 후보 기준으로 쓰지 않는다
  assert.ok(got.every((p) => !p.startsWith(`${ws}/`)));
  // 만진 폴더 바로 아래 상대 경로
  assert.ok(outsideCandidates("components/pagePromiseReport/schedules.ts", inputs, ws).includes("/Users/me/Repository/app-client/app-webview/src/components/pagePromiseReport/schedules.ts"));
  // 도구가 직접 읽은 파일이 rel 로 끝나면 맨 앞
  const read = [JSON.stringify({ file_path: "/Users/me/Repository/other/pkg/src/x.ts" })];
  assert.equal(outsideCandidates("src/x.ts", read, ws)[0], "/Users/me/Repository/other/pkg/src/x.ts");
  // 작업 폴더 밖으로 나가는 경로와 도구 입력이 없으면 후보 없음
  assert.deepEqual(outsideCandidates("../x.ts", inputs, ws), []);
  assert.deepEqual(outsideCandidates("src/x.ts", [], ws), []);
  // 홈 폴더 자체는 기준으로 쓰지 않는다
  assert.deepEqual(outsideCandidates("x.ts", [JSON.stringify({ command: "ls /Users/me" })], ws), []);
}

console.log("filerefresolve ok");
