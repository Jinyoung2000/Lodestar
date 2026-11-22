import { snippet, type Completion, type CompletionSource } from "@codemirror/autocomplete";


type BuiltinSnippet = { prefix: string; description: string; body: string };

export const BUILTIN_SNIPPETS: BuiltinSnippet[] = [
  { prefix: "log", description: "Log to the console", body: "console.log($1);\n$0" },
  { prefix: "warn", description: "Log warning to the console", body: "console.warn($1);\n$0" },
  { prefix: "error", description: "Log error to the console", body: "console.error($1);\n$0" },
  { prefix: "throw", description: "Throw Exception", body: 'throw new Error("$1");\n$0' },
  { prefix: "import", description: "Import external module", body: 'import { $0 } from "${1:module}";' },
  { prefix: "class", description: "Class Definition", body: "class ${1:name} {\n\tconstructor(${2:parameters}) {\n\t\t$0\n\t}\n}" },
  { prefix: "ctor", description: "Constructor", body: "/**\n *\n */\nconstructor() {\n\tsuper();\n\t$0\n}" },
  { prefix: "for", description: "For Loop", body: "for (let ${1:index} = 0; ${1:index} < ${2:array}.length; ${1:index}++) {\n\tconst ${3:element} = ${2:array}[${1:index}];\n\t$TM_SELECTED_TEXT$0\n}" },
  { prefix: "foreach", description: "For-Each Loop using =>", body: "${1:array}.forEach(${2:element} => {\n\t$TM_SELECTED_TEXT$0\n});" },
  { prefix: "forin", description: "For-In Loop", body: "for (const ${1:key} in ${2:object}) {\n\tif (!Object.hasOwn(${2:object}, ${1:key})) continue;\n\t\n\tconst ${3:element} = ${2:object}[${1:key}];\n\t\n\t$TM_SELECTED_TEXT$0\n}" },
  { prefix: "forof", description: "For-Of Loop", body: "for (const ${1:element} of ${2:object}) {\n\t$TM_SELECTED_TEXT$0\n}" },
  { prefix: "forawaitof", description: "For-Await-Of Loop", body: "for await (const ${1:element} of ${2:object}) {\n\t$TM_SELECTED_TEXT$0\n}" },
  { prefix: "function", description: "Function Statement", body: "function ${1:name}(${2:params}:${3:type}) {\n\t$TM_SELECTED_TEXT$0\n}" },
  { prefix: "if", description: "If Statement", body: "if (${1:condition}) {\n\t$TM_SELECTED_TEXT$0\n}" },
  { prefix: "ifelse", description: "If-Else Statement", body: "if (${1:condition}) {\n\t$TM_SELECTED_TEXT$0\n} else {\n\t\n}" },
  { prefix: "new", description: "New Statement", body: "const ${1:name} = new ${2:type}(${3:arguments});$0" },
  { prefix: "switch", description: "Switch Statement", body: "switch (${1:key}) {\n\tcase ${2:value}:\n\t\t$0\n\t\tbreak;\n\n\tdefault:\n\t\tbreak;\n}" },
  { prefix: "while", description: "While Statement", body: "while (${1:condition}) {\n\t$TM_SELECTED_TEXT$0\n}" },
  { prefix: "dowhile", description: "Do-While Statement", body: "do {\n\t$TM_SELECTED_TEXT$0\n} while (${1:condition});" },
  { prefix: "trycatch", description: "Try-Catch Statement", body: "try {\n\t$TM_SELECTED_TEXT$0\n} catch (${1:error}) {\n\t\n}" },
  { prefix: "settimeout", description: "Set Timeout Function", body: "setTimeout(() => {\n\t$TM_SELECTED_TEXT$0\n}, ${1:timeout});" },
  { prefix: "setinterval", description: "Set Interval Function", body: "setInterval(() => {\n\t$TM_SELECTED_TEXT$0\n}, ${1:interval});" },
  { prefix: "newpromise", description: "Create a new Promise", body: "new Promise<${1:void}>((resolve, reject) => {\n\t$TM_SELECTED_TEXT$0\n})" },
];

export function toCodeMirrorSnippet(body: string): string {
  return body
    .replace(/\$TM_SELECTED_TEXT/g, "")
    .replace(/\$0/g, "${}")
    .replace(/\$(\d+)/g, "${$1}");
}

export function snippetOptions(): Completion[] {
  return BUILTIN_SNIPPETS.map((s) => ({
    label: s.prefix,
    detail: s.description,
    type: "snippet",
    boost: -5,
    apply: snippet(toCodeMirrorSnippet(s.body)),
  }));
}

export const builtinSnippetSource: CompletionSource = (context) => {
  const word = context.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  if (context.state.sliceDoc(Math.max(0, word.from - 1), word.from) === ".") return null;
  return { from: word.from, options: snippetOptions(), validFor: /^\w*$/ };
};
