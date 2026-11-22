
export type DisplayPart = { text: string; kind: string };

type Category = "variable" | "function" | "named" | "unknown";

export function typeFromParts(parts: DisplayPart[]): string | null {
  const head = headOf(parts);
  switch (head.category) {
    case "variable":
      return render(afterNameColon(head.body));
    case "function":
      return render(returnTypeOf(head.body));
    case "named":
      return nameOf(head.body);
    default:
      return null;
  }
}

export function signatureFromParts(parts: DisplayPart[]): string | null {
  const head = headOf(parts);
  if (head.category === "function") {
    const body = head.body;
    const open = firstParamsOpen(body);
    if (open < 0) return null;
    const close = matching(body, open);
    if (close < 0) return null;
    const typeParams = render(body.slice(nameEnd(body), open));
    const params = render(body.slice(open, close + 1));
    const ret = render(returnTypeOf(body));
    return ret === null || params === null ? null : `${typeParams ?? ""}${params} => ${ret}`;
  }
  if (head.category === "variable") {
    const type = render(afterNameColon(head.body));
    return type !== null && isFunctionType(type) ? type : null;
  }
  return null;
}

export function isFunctionType(type: string) {
  if (!/^[(<]/.test(type)) return false;
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    const ch = type[i]!;
    if ("([{<".includes(ch) && !(ch === "<" && type[i - 1] === "=")) depth++;
    else if (")]}".includes(ch) || (ch === ">" && type[i - 1] !== "=")) depth--;
    else if (depth === 0 && ch === "=" && type[i + 1] === ">") return true;
  }
  return false;
}

const MODIFIERS = new Set(["export", "declare", "default", "abstract", "async", "readonly", "static", "public", "private", "protected", "override"]);
const VARIABLE_WORDS = new Set(["const", "let", "var", "using"]);
const NAMED_WORDS = new Set(["class", "interface", "type", "enum", "namespace", "module"]);
const VARIABLE_LABELS = new Set(["property", "parameter", "local var", "local const", "local let", "var", "let", "const", "getter", "setter", "JSX attribute"]);
const FUNCTION_LABELS = new Set(["method", "local function"]);

function headOf(all: DisplayPart[]): { category: Category; body: DisplayPart[] } {
  const parts = cutAfterAlias(all);
  let label: string | null = null;
  let i = 0;
  if (text(parts[i]) === "(" && parts[i + 2]?.text === ")") {
    label = parts[i + 1]!.text;
    i += 3;
  }
  while (parts[i] && (parts[i]!.kind === "space" || (parts[i]!.kind === "keyword" && MODIFIERS.has(parts[i]!.text)))) i++;
  const word = parts[i]?.kind === "keyword" || parts[i]?.kind === "text" ? parts[i]!.text : null;
  if (word === "function") return { category: "function", body: skipSpaces(parts, i + 1) };
  if (word && VARIABLE_WORDS.has(word)) return { category: "variable", body: skipSpaces(parts, i + 1) };
  if (word && NAMED_WORDS.has(word)) return { category: "named", body: skipSpaces(parts, i + 1) };
  if (label && FUNCTION_LABELS.has(label)) return { category: "function", body: skipSpaces(parts, i) };
  if (label && VARIABLE_LABELS.has(label)) return { category: "variable", body: skipSpaces(parts, i) };
  return { category: "unknown", body: [] };
}

function cutAfterAlias(parts: DisplayPart[]) {
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i]!.kind === "lineBreak" && parts[i + 1]!.kind === "keyword" && parts[i + 1]!.text === "import") return parts.slice(0, i);
  }
  return parts;
}

const text = (part: DisplayPart | undefined) => part?.text;
const skipSpaces = (parts: DisplayPart[], from: number) => {
  let i = from;
  while (parts[i]?.kind === "space") i++;
  return parts.slice(i);
};

function nameEnd(body: DisplayPart[]) {
  let i = 0;
  while (body[i] && (isNameKind(body[i]!.kind) || (body[i]!.kind === "punctuation" && body[i]!.text === "." && body[i + 1] && isNameKind(body[i + 1]!.kind)))) i++;
  return i;
}

function isNameKind(kind: string) {
  return /Name$/.test(kind) || kind === "text" || kind === "localName" || kind === "parameterName" || kind === "propertyName";
}

function nameOf(body: DisplayPart[]) {
  const end = nameEnd(body);
  return end > 0 ? body.slice(0, end).map((p) => p.text).join("") : null;
}

function afterNameColon(body: DisplayPart[]) {
  let i = nameEnd(body);
  if (body[i]?.text === "?" && body[i]?.kind === "punctuation") i++;
  if (body[i]?.text !== ":") return [];
  return skipSpaces(body, i + 1);
}

function firstParamsOpen(body: DisplayPart[]) {
  let i = nameEnd(body);
  if (body[i]?.text === "<") {
    const close = matching(body, i);
    if (close < 0) return -1;
    i = close + 1;
  }
  return body[i]?.text === "(" ? i : -1;
}

function returnTypeOf(body: DisplayPart[]) {
  const open = firstParamsOpen(body);
  if (open < 0) return [];
  const close = matching(body, open);
  if (close < 0 || body[close + 1]?.text !== ":") return [];
  return stripOverloadTail(skipSpaces(body, close + 2));
}

function matching(parts: DisplayPart[], open: number) {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
  const stack: string[] = [];
  for (let i = open; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.kind !== "punctuation" && part.kind !== "operator") continue;
    if (part.text in pairs) stack.push(pairs[part.text]!);
    else if (part.text === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

function stripOverloadTail(parts: DisplayPart[]) {
  const last = parts.length - 1;
  if (parts[last]?.text !== ")") return parts;
  for (let i = last - 1; i >= 0; i--) {
    if (parts[i]!.text === "(" && parts[i + 1]?.text === "+") {
      const tail = parts.slice(i).map((p) => p.text).join("");
      if (/^\(\+\d+ overloads?\)$/.test(tail)) {
        let end = i;
        while (end > 0 && parts[end - 1]!.kind === "space") end--;
        return parts.slice(0, end);
      }
      return parts;
    }
  }
  return parts;
}

function render(parts: DisplayPart[]): string | null {
  if (!parts.length) return null;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.kind === "lineBreak" || part.kind === "space") {
      if (out.length && out[out.length - 1] !== " ") out.push(" ");
      continue;
    }
    if (part.kind === "punctuation" && part.text === ";") {
      let next = i + 1;
      while (parts[next] && (parts[next]!.kind === "lineBreak" || parts[next]!.kind === "space")) next++;
      if (parts[next]?.kind === "punctuation" && parts[next]!.text === "}") continue;
    }
    out.push(part.text);
  }
  const result = out.join("").trim();
  return result || null;
}
