
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

const BY_INTERPRETER: [RegExp, LanguageId][] = [
  [/^(?:ba|z|da|k|a)?sh$/, "shell"],
  [/^python[\d.]*$/, "python"],
  [/^(?:node|nodejs|bun|deno)$/, "javascript"],
  [/^tsx$|^ts-node$/, "typescript"],
];

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
}

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

export function mayHaveShebang(path: string): boolean {
  return baseName(path) !== "" && languageIdFor(path) === null;
}

function languageIdByNamePattern(name: string, firstLine?: string): LanguageId | null {
  if (name.endsWith(".dockerignore") || name.endsWith(".gitignore")) return "gitignore";
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name.startsWith("makefile.")) return "makefile";
  if (name === ".env" || name.startsWith(".env.")) return "properties";
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
