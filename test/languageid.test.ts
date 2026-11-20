// 파일 경로로 구문 색 언어를 정하는 순수 함수 시험. 확장자, 대소문자, 이름만 있는 파일, 셔뱅, 모르는 확장자, 마크다운 코드 펜스 이름.
// 실행: npm test
import { languageIdFor, languageIdForFence, mayHaveShebang } from "../web/languageId";
import { highlightLines } from "../web/prHighlight";
import { loadLanguage } from "../web/languages";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const is = (path: string, expected: string | null, firstLine?: string) => check(`${path}${firstLine ? ` [${firstLine}]` : ""} -> ${expected}`, languageIdFor(path, firstLine) === expected, String(languageIdFor(path, firstLine)));

// 확장자
for (const [path, id] of [
  ["a.ts", "typescript"],
  ["a.d.ts", "typescript"],
  ["src/a.test.tsx", "typescriptreact"],
  ["a.mjs", "javascript"],
  ["a.jsx", "javascriptreact"],
  ["a.json", "json"],
  ["a.css", "css"],
  ["README.md", "markdown"],
  [".github/workflows/ci.yml", "yaml"],
  ["config.yaml", "yaml"],
  [".yarnrc.yml", "yaml"],
  ["run.sh", "shell"],
  ["a.zsh", "shell"],
  ["a.bash", "shell"],
  ["schema.graphql", "graphql"],
  ["q.gql", "graphql"],
  ["index.html", "html"],
  ["page.ejs", "html"],
  ["Page.astro", "html"],
  ["icon.svg", "xml"],
  ["a.xml", "xml"],
  ["q.sql", "sql"],
  ["a.py", "python"],
  ["Cargo.toml", "toml"],
  ["a.ini", "properties"],
  ["redis.conf", "properties"],
  ["main.go", "go"],
  ["A.kt", "kotlin"],
  ["build.gradle.kts", "kotlin"],
  ["A.java", "java"],
  ["a.swift", "swift"],
  ["x.diff", "diff"],
  ["x.patch", "diff"],
  ["rules.mk", "makefile"],
] as const) is(path, id);

// 대소문자
is("README.MD", "markdown");
is("A.YAML", "yaml");
is("Dockerfile", "dockerfile");
is("DOCKERFILE", "dockerfile");
is("MAKEFILE", "makefile");

// 이름만 있는 파일과 이름 규칙
is("Dockerfile", "dockerfile");
is("services/api/Dockerfile.query-rabbit", "dockerfile");
is("app.dockerfile", "dockerfile");
is("Makefile", "makefile");
is("nginx.conf", "nginx");
is(".gitignore", "gitignore");
is("Dockerfile.query-rabbit.dockerignore", "gitignore");
is(".dockerignore", "gitignore");
is(".git-blame-ignore-revs", "gitignore");
is("CODEOWNERS", "gitignore");
is(".env", "properties");
is(".env.local.example", "properties");
is(".env.dev", "properties");
is(".editorconfig", "properties");
is(".npmrc", "properties");
is(".zshrc", "shell");
is(".babelrc", "json");
is(".prettierrc", "yaml");
is(".prettierrc", "json", "{");
is("C:\\work\\Dockerfile", "dockerfile");

// 셔뱅은 이름으로 못 정할 때만
is("bin/deploy", "shell", "#!/bin/bash");
is("bin/deploy", "shell", "#!/usr/bin/env bash");
is("bin/deploy", "shell", "#!/usr/bin/env -S bash -e");
is("script", "python", "#!/usr/bin/env python3");
is("tool", "javascript", "#!/usr/bin/env node");
is("tool", null, "#!/usr/bin/perl");
is("tool", null, "just text");
is("run.sh", "shell", "#!/usr/bin/python");
is("data.json", "json", "#!/bin/bash");
check("셔뱅을 볼 파일은 이름으로 못 정한 파일뿐", mayHaveShebang("bin/deploy") && !mayHaveShebang("a.ts") && !mayHaveShebang("Dockerfile"));

// 모르는 확장자와 빈 경로
is("a.xyz", null);
is("yarn.lock", null);
is("photo.png", null);
is("LICENSE", null);
is("", null);
is("src/", null);
is(".hidden", null);

// 마크다운 코드 펜스
for (const [info, id] of [
  ["yaml", "yaml"],
  ["YML", "yaml"],
  ["bash", "shell"],
  ["sh", "shell"],
  ["gql", "graphql"],
  ["py", "python"],
  ["dockerfile", "dockerfile"],
  ["typescript", "typescript"],
  ["tsx", "typescriptreact"],
  ["jsonc", "json"],
  ["kt", "kotlin"],
] as const) check(`fence ${info} -> ${id}`, languageIdForFence(info) === id);
check("fence text, 빈 문자열, 모르는 이름은 null", languageIdForFence("text") === null && languageIdForFence("") === null && languageIdForFence("brainfuck") === null);

// 언어를 읽은 뒤 실제로 여러 색이 나온다(단색이 아니다)
const SAMPLES: [string, string[]][] = [
  ["a.yaml", ["# c", "name: CI", "n: 20", "ok: true", 'k: "v"']],
  ["a.sh", ["#!/bin/sh", "# c", 'git commit -m "x $A"']],
  ["a.graphql", ["# c", "query Q($id: ID!) { user(id: $id) { name } }"]],
  ["a.py", ["import os", "def f(x):", "    return 'a' + str(1)  # c"]],
  ["Dockerfile", ["FROM node:20", "# c", 'CMD ["node", "x.js"]']],
  ["a.sql", ["-- c", "SELECT id FROM t WHERE n > 10 AND s = 'x';"]],
  ["a.html", ['<div class="a">hi</div>']],
  ["a.toml", ["# c", "[p]", 'n = "x"', "k = 5"]],
  [".env", ["# c", "KEY=value"]],
  ["a.go", ["package main", "// c", 'func main() { println("hi", 3) }']],
  ["A.kt", ["@Foo", 'class A { fun f(): String = "s" }']],
  ["A.java", ["// c", '@Override public class A { int x = 1; String s = "a"; }']],
  ["a.swift", ["import Foo", 'func f() -> Int { return 1 }']],
  ["a.diff", ["@@ -1 +1 @@", "-old", "+new"]],
  [".gitignore", ["# c", "!keep", "*.log"]],
  ["a.xml", ['<a b="c"><!-- c --></a>']],
];
for (const [path, lines] of SAMPLES) {
  const id = languageIdFor(path, lines[0]);
  if (!id) {
    check(`${path} 언어 결정`, false);
    continue;
  }
  await loadLanguage(id);
  const classes = new Set(highlightLines(lines, path).flat().map((s) => s.cls).filter((c): c is string => c !== null));
  check(`${path} 색 종류 2개 이상`, classes.size >= 2, [...classes].map((c) => c.replace("cm-syn-", "")).join(","));
}

// YAML 값의 숫자, 불리언, 문자열은 서로 다른 색이다
{
  await loadLanguage("yaml");
  const segs = highlightLines(["a: 12", "b: true", "c: hello", "d: null"], "a.yaml").map((line) => line.find((s) => s.text.trim() !== "" && !s.text.startsWith(":") && s.text !== "a" && s.text !== "b" && s.text !== "c" && s.text !== "d" && s.text.trim() !== ":")?.cls);
  check("yaml 값: 숫자 number, true kw, 문자열 string, null kw", segs.join(",") === "cm-syn-number,cm-syn-kw,cm-syn-string,cm-syn-kw", segs.join(","));
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
