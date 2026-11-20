// 파일 경로(확장자, 파일 이름, 셔뱅 첫 줄)와 마크다운 코드 펜스 이름으로 구문 색 언어를 정하는 순수 함수.
// 에디터, diff, PR diff, 대화의 코드 블록, 검색 결과가 모두 이 결과(LanguageId)를 같이 쓴다. 파서를 읽어 오는 일은 web/languages.ts 가 한다.

export type LanguageId =
  | "typescript"
  | "typescriptreact"
  | "javascript"
  | "javascriptreact"
  | "json"
  | "css"
  | "markdown"
  | "yaml"
  | "shell"
  | "makefile"
  | "graphql"
  | "html"
  | "xml"
  | "sql"
  | "python"
  | "dockerfile"
  | "toml"
  | "properties"
  | "nginx"
  | "gitignore"
  | "go"
  | "kotlin"
  | "java"
  | "swift"
  | "objectivec"
  | "diff";

// 확장자(소문자, 점 없이)로 정하는 언어. 마지막 확장자만 본다(a.test.ts 는 ts, yarnrc.yml 은 yml).
const BY_EXTENSION: Record<string, LanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "json",
  json5: "json",
  "code-workspace": "json",
  webmanifest: "json",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  command: "shell",
  mk: "makefile",
  graphql: "graphql",
  graphqls: "graphql",
  gql: "graphql",
  html: "html",
  htm: "html",
  xhtml: "html",
  ejs: "html",
  astro: "html",
  vue: "html",
  svelte: "html",
  hbs: "html",
  xml: "xml",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  plist: "xml",
  csproj: "xml",
  sql: "sql",
  py: "python",
  pyi: "python",
  pyw: "python",
  toml: "toml",
  ini: "properties",
  cfg: "properties",
  conf: "properties",
  properties: "properties",
  env: "properties",
  editorconfig: "properties",
  go: "go",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  swift: "swift",
  m: "objectivec",
  mm: "objectivec",
  diff: "diff",
  patch: "diff",
};

// 파일 이름 전체(소문자)로 정하는 언어. 확장자보다 먼저 본다.
const BY_NAME: Record<string, LanguageId> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "nginx.conf": "nginx",
  ".gitignore": "gitignore",
  ".gitattributes": "gitignore",
  ".gitmodules": "properties",
  ".git-blame-ignore-revs": "gitignore",
  ".dockerignore": "gitignore",
  ".npmignore": "gitignore",
  ".prettierignore": "gitignore",
  ".eslintignore": "gitignore",
  ".stylelintignore": "gitignore",
  ".gcloudignore": "gitignore",
  ".vscodeignore": "gitignore",
  ".slugignore": "gitignore",
  ".helmignore": "gitignore",
  codeowners: "gitignore",
  ".editorconfig": "properties",
  ".npmrc": "properties",
  ".yarnrc": "properties",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".swcrc": "json",
  ".watchmanconfig": "json",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_aliases": "shell",
  ".zshrc": "shell",
  ".zshenv": "shell",
  ".zprofile": "shell",
  ".zlogin": "shell",
  ".profile": "shell",
  ".envrc": "shell",
};

// 첫 줄이 `#!` 인 파일의 해석기 이름으로 정하는 언어
const BY_INTERPRETER: [RegExp, LanguageId][] = [
  [/^(?:ba|z|da|k|a)?sh$/, "shell"],
  [/^python[\d.]*$/, "python"],
  [/^(?:node|nodejs|bun|deno)$/, "javascript"],
  [/^tsx$|^ts-node$/, "typescript"],
];

// 파일 경로의 마지막 이름을 소문자로. 윈도 구분자도 받는다.
function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
}

// 파일 경로로 언어를 정한다. 모르면 null. firstLine 은 이름만으로 못 정할 때 셔뱅을 보는 데만 쓴다.
// 우선순위: 이름 전체 일치 > Dockerfile.* 같은 이름 규칙 > 확장자 > 셔뱅.
export function languageIdFor(path: string, firstLine?: string): LanguageId | null {
  const name = baseName(path);
  if (!name) return null;
  const byName = BY_NAME[name];
  if (byName) return byName;
  const byPattern = languageIdByNamePattern(name, firstLine);
  if (byPattern) return byPattern;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const byExtension = BY_EXTENSION[name.slice(dot + 1)];
    if (byExtension) return byExtension;
  }
  return firstLine ? languageIdByShebang(firstLine) : null;
}

// 첫 줄(셔뱅)로 정할 수 있는 파일인지. 에디터가 문서를 열고 나서 첫 줄을 읽을지 정할 때 쓴다.
export function mayHaveShebang(path: string): boolean {
  return baseName(path) !== "" && languageIdFor(path) === null;
}

function languageIdByNamePattern(name: string, firstLine?: string): LanguageId | null {
  // Dockerfile.query-rabbit, query.dockerfile. 뒤에 .dockerignore 가 붙으면 무시 파일이다.
  if (name.endsWith(".dockerignore") || name.endsWith(".gitignore")) return "gitignore";
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name.startsWith("makefile.")) return "makefile";
  // .env, .env.local, .env.production.example
  if (name === ".env" || name.startsWith(".env.")) return "properties";
  // .prettierrc 는 YAML 이거나 JSON 이다. 첫 글자가 { 면 JSON.
  if (name === ".prettierrc" || name === ".stylelintrc" || name === ".markdownlintrc") return firstLine?.trimStart().startsWith("{") ? "json" : "yaml";
  if (name.endsWith(".nginx")) return "nginx";
  return null;
}

function languageIdByShebang(firstLine: string): LanguageId | null {
  const match = /^#!\s*(\S+)(?:\s+(?:-\S+\s+)*(\S+))?/.exec(firstLine);
  if (!match) return null;
  const program = match[1].slice(match[1].lastIndexOf("/") + 1);
  const interpreter = program === "env" ? (match[2] ?? "") : program;
  for (const [pattern, id] of BY_INTERPRETER) if (pattern.test(interpreter)) return id;
  return null;
}

// 마크다운 코드 펜스(```yaml)와 LSP 언어 이름으로 언어를 정한다. text, plaintext 처럼 색이 없는 이름과 모르는 이름은 null.
const BY_FENCE: Record<string, LanguageId> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescriptreact",
  typescriptreact: "typescriptreact",
  js: "javascript",
  javascript: "javascript",
  node: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  javascriptreact: "javascriptreact",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  shellscript: "shell",
  ksh: "shell",
  make: "makefile",
  makefile: "makefile",
  graphql: "graphql",
  gql: "graphql",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  sql: "sql",
  pgsql: "sql",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
  python: "python",
  py: "python",
  python3: "python",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  toml: "toml",
  ini: "properties",
  properties: "properties",
  env: "properties",
  dotenv: "properties",
  conf: "properties",
  nginx: "nginx",
  gitignore: "gitignore",
  go: "go",
  golang: "go",
  kotlin: "kotlin",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  swift: "swift",
  objc: "objectivec",
  objectivec: "objectivec",
  "objective-c": "objectivec",
  objcpp: "objectivec",
  "objective-cpp": "objectivec",
  diff: "diff",
  patch: "diff",
};

export function languageIdForFence(info: string): LanguageId | null {
  return BY_FENCE[info.trim().toLowerCase()] ?? null;
}
