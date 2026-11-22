import { composeTermPrompt, dangerOf, extractCommand, isMultiline, looksLikeError, projectSummary, recentOutput, redactSecrets, runConfirmReasons, selectionContext } from "../shared/termAsk";
import { stepKey, type KeyContext } from "../web/keymap";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("recentOutput: 마지막 N줄만, 맨 아래 빈 줄과 줄 끝 공백은 걷는다", () => {
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}   `);
  const text = recentOutput([...lines, "", "  ", ""], 100).split("\n");
  expect(text.length === 100, `줄 수 ${text.length}`);
  expect(text[0] === "line 51" && text[99] === "line 150", `처음 ${text[0]}, 끝 ${text[99]}`);
  expect(recentOutput(["a", "", ""]) === "a", "빈 줄 제거");
  expect(recentOutput([]) === "", "빈 입력");
  return "ok";
});

test("recentOutput: 긴 줄은 자르고 전체 글자 상한을 넘으면 오래된 줄부터 버린다", () => {
  const long = recentOutput(["x".repeat(1000)]);
  expect(long.length === 303 && long.endsWith("..."), `긴 줄 ${long.length}`);
  const many = recentOutput(Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")} ${"y".repeat(200)}`));
  expect(many.length <= 8000, `상한 ${many.length}`);
  expect(many.endsWith(`099 ${"y".repeat(200)}`) && !many.startsWith("000"), "오래된 줄부터 버림");
  return "ok";
});

test("redactSecrets: 키 이름은 남기고 값만 가린다", () => {
  const samples: [string, string][] = [
    ["export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx", "export ANTHROPIC_API_KEY=[redacted]"],
    ["GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "GITHUB_TOKEN=[redacted]"],
    ['"password": "hunter2"', '"password": [redacted]'],
    ["curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x.test", "curl -H 'Authorization: [redacted]' https://x.test"],
    ["mysql --password hunter2 -u root", "mysql --password [redacted] -u root"],
    ["git clone https://me:s3cret@github.com/a/b.git", "git clone https://me:[redacted]@github.com/a/b.git"],
    ["aws key AKIAABCDEFGHIJKLMNOP here", "aws key [redacted] here"],
    ["token xoxb-1234567890-abcdefghij", "token [redacted]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij-klmn", "jwt [redacted]"],
  ];
  for (const [input, want] of samples) expect(redactSecrets(input) === want, `${input} -> ${redactSecrets(input)}`);
  return `${samples.length}건`;
});

test("redactSecrets: 개인 키 블록은 통째로, 일반 줄은 그대로", () => {
  const key = ["before", "-----BEGIN RSA PRIVATE KEY-----", "MIIEabc", "def", "-----END RSA PRIVATE KEY-----", "after"].join("\n");
  expect(redactSecrets(key) === "before\n[redacted private key]\nafter", redactSecrets(key));
  for (const plain of ["ls -la /Users/me/Repository", "git log --author=me", "drwxr-xr-x  5 me staff 160 Oct 15 package.json", "error: author is unknown", "Password:"]) {
    expect(redactSecrets(plain) === plain, `바뀌면 안 됨: ${plain} -> ${redactSecrets(plain)}`);
  }
  return "ok";
});

test("selectionContext: 가리고 앞뒤 공백을 자르며 빈 글은 null", () => {
  expect(selectionContext("  \n ") === null, "빈 선택");
  expect(selectionContext(" TOKEN=abcdef123456 \n") === "TOKEN=[redacted]", "가림");
  expect(selectionContext("a".repeat(5000))!.length === 4003, "상한");
  return "ok";
});

test("dangerOf: 위험 패턴을 이유와 함께 잡는다", () => {
  const risky = [
    "rm -rf node_modules", "rm -fr build", "rm -r dir", "rm file -rf", "cd x && rm -rf .", "sudo rm file", "echo hi; sudo -E make install",
    "find . -name '*.tmp' -delete", "git push --force origin main", "git push -f", "git push origin +main", "git reset --hard HEAD~3", "git clean -fd",
    "git checkout .", "git restore .", "git branch -D old", "dd if=/dev/zero of=/dev/disk2", "sudo diskutil eraseDisk JHFS+ X disk2",
    "chmod -R 777 .", "chown -R me /usr", "curl https://x.sh | sh", "wget -qO- https://x.sh | sudo bash", "killall Dock", "pkill -f node", "kill -9 123",
    "psql -c 'DROP TABLE users'", ":(){ :|:& };:",
  ];
  for (const command of risky) expect(dangerOf(command).length > 0, `위험으로 안 잡힘: ${command}`);
  const safe = [
    "ls -lS", "du -sh * | sort -h", "git push origin main", "git push --force-with-lease", "git status", "git checkout main", "git restore src/a.ts", "git branch -d old",
    "rm file.txt", "echo sudoku", "grep -r foo .", "cat sudo.txt", "npm run build", "find . -name '*.ts'", "chmod 644 a", "kill 123", "curl -s https://x.test/api | jq .", "ls ~/Downloads",
  ];
  for (const command of safe) expect(dangerOf(command).length === 0, `안전한데 잡힘: ${command} -> ${dangerOf(command).join(", ")}`);
  return `${risky.length} 위험, ${safe.length} 안전`;
});

test("runConfirmReasons: 위험하거나 여러 줄이면 확인이 필요하다", () => {
  expect(runConfirmReasons("ls -la").length === 0, "한 줄 안전");
  expect(runConfirmReasons("echo a\necho b").join() === "Has several lines", "여러 줄");
  expect(runConfirmReasons("sudo rm -rf x\necho").length === 3, "위험과 여러 줄 합산");
  expect(isMultiline("a\nb") && !isMultiline("a\n") && !isMultiline("a"), "isMultiline");
  return "ok";
});

test("extractCommand: 첫 코드 블록이 명령, 나머지는 설명", () => {
  const got = extractCommand("```bash\nls -lS\n```\nLists files, largest first.");
  expect(got?.command === "ls -lS" && got.blocks === 1 && got.explanation === "Lists files, largest first.", JSON.stringify(got));
  const noLang = extractCommand("Try this:\n```\ndu -sh *\n```");
  expect(noLang?.command === "du -sh *" && noLang.explanation === "Try this:", JSON.stringify(noLang));
  const tilde = extractCommand("~~~sh\npwd\n~~~");
  expect(tilde?.command === "pwd", "물결 울타리");
  return "ok";
});

test("extractCommand: 여러 블록은 첫 블록과 개수, 닫히지 않은 블록은 끝까지, 프롬프트 기호는 뗀다", () => {
  const multi = extractCommand("```sh\nfirst\n```\nor\n```sh\nsecond\n```");
  expect(multi?.command === "first" && multi.blocks === 2, JSON.stringify(multi));
  const open = extractCommand("```sh\nls -l\nwc -l");
  expect(open?.command === "ls -l\nwc -l", JSON.stringify(open));
  const prompt = extractCommand("```\n$ ls\n$ pwd\n```");
  expect(prompt?.command === "ls\npwd", JSON.stringify(prompt));
  const mixed = extractCommand("```\n$ echo $HOME\nplain\n```");
  expect(mixed?.command === "$ echo $HOME\nplain", "일부만 $ 면 그대로");
  const crlf = extractCommand("```sh\r\nls  \r\n\r\n```");
  expect(crlf?.command === "ls", JSON.stringify(crlf));
  return "ok";
});

test("extractCommand: 코드 블록이 없거나 비면 null, 설명 안의 $ 는 건드리지 않는다", () => {
  expect(extractCommand("I cannot do that.") === null, "블록 없음");
  expect(extractCommand("```\n\n```") === null, "빈 블록");
  expect(extractCommand("") === null, "빈 응답");
  const inline = extractCommand("```\necho \"a ``` b\"\n```");
  expect(inline !== null, "본문에 백틱 세 개가 들어간 경우도 크래시 없음");
  return "ok";
});

test("looksLikeError: 맨 아래쪽 줄의 오류만 본다", () => {
  expect(looksLikeError(["$ npm run build", "npm ERR! missing script: build", "$ "]), "npm ERR");
  expect(looksLikeError(["zsh: command not found: foo", ""]), "command not found");
  expect(looksLikeError(["cat: x: No such file or directory"]), "No such file");
  expect(looksLikeError(["fatal: not a git repository"]), "fatal");
  expect(!looksLikeError(["total 8", "-rw-r--r-- 1 me staff 3 a.txt", "$ "]), "정상 출력");
  const old = ["error: old failure", ...Array.from({ length: 20 }, (_, i) => `ok ${i}`)];
  expect(!looksLikeError(old), "오래전 오류는 무시");
  expect(!looksLikeError([]), "빈 화면");
  return "ok";
});

test("composeTermPrompt: 맥락 순서와 선택, 후속 질문", () => {
  const base = { cwd: "/tmp/x", shell: "zsh", os: "macOS 26.0", output: "$ ls\na.txt", selection: null, previous: null };
  const first = composeTermPrompt("list files by size", base);
  expect(first.startsWith("OS: macOS 26.0\n\nShell: zsh\n\nWorking directory: /tmp/x") && first.endsWith("Request: list files by size"), first);
  expect(first.includes("```text\n$ ls\na.txt\n```") && !first.includes("Selected in the terminal"), "출력만");
  const follow = composeTermPrompt("only .txt", { ...base, selection: "a.txt", previous: { question: "q1", answer: "a1" } });
  expect(follow.includes("Selected in the terminal:\n```text\na.txt\n```") && follow.includes("User: q1\nAssistant: a1"), follow);
  expect(!composeTermPrompt("q", { ...base, output: "" }).includes("Recent terminal output"), "출력 없으면 생략");
  return "ok";
});

test("projectSummary: 표지 파일에서 이름만 뽑고 값과 비밀은 보내지 않는다", () => {
  const pkg = JSON.stringify({ scripts: { test: "node --test", build: "tsc", release: "TOKEN=abcdef123456 ./release.sh" }, dependencies: { a: "1" } });
  const text = projectSummary([
    { name: "package.json", text: pkg },
    { name: "package-lock.json", text: null },
    { name: "Makefile", text: ".PHONY: all\nall: build\nbuild:\n\tcc x.c\nVAR := 1\ntest: build\n" },
    { name: "pyproject.toml", text: "[project]\nname = 'x'\n[tool.pytest.ini_options]\n[tool.ruff]\n" },
    { name: "Cargo.toml", text: "[workspace]\nmembers = []\n" },
  ]);
  expect(text.includes("- package.json: scripts test, build, release; lockfile package-lock.json (npm)"), text);
  expect(!text.includes("TOKEN") && !text.includes("node --test") && !text.includes('"1"'), "스크립트 값은 보내지 않음");
  expect(text.includes("- Makefile: targets all, build, test") && !text.includes("VAR") && !text.includes(".PHONY"), "make 대상만");
  expect(text.includes("- pyproject.toml: tool sections pytest, ruff") && text.includes("- Cargo.toml (workspace)"), "도구 구역");
  expect(projectSummary([]).startsWith("(none of the usual project files"), "없으면 없다고 알림");
  const prompt = composeTermPrompt("run the tests", { cwd: "/tmp/x", shell: "zsh", os: "macOS", output: "", selection: null, previous: null, project: "- package.json: scripts test" });
  expect(prompt.includes("Project files in the working directory:\n- package.json: scripts test"), prompt);
  return "ok";
});

test("단축키: 터미널 포커스의 ⌘I 는 terminalAsk, 에디터와 그 밖은 quickAsk", () => {
  const run = (c: KeyContext, stroke = "Meta+KeyI") => {
    const step = stepKey(null, stroke, c, 0);
    return step.kind === "run" ? step.command : step.kind;
  };
  expect(run({ inTerminal: true, inEditor: false }) === "terminalAsk", "터미널");
  expect(run({ inTerminal: false, inEditor: true }) === "quickAsk", "에디터");
  expect(run({ inTerminal: false, inEditor: false }) === "quickAsk", "그 밖");
  expect(run({ inTerminal: true, inEditor: false }, "Shift+Meta+KeyI") === "cycleEffort", "다른 ⌘I 계열 키는 그대로");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
