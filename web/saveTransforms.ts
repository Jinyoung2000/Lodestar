import { ChangeSet, type ChangeSpec, type Text } from "@codemirror/state";


export type SaveTransformOptions = { trimTrailingWhitespace: boolean; insertFinalNewline: boolean; trimFinalNewlines: boolean };
export type SaveTransformPhase = "beforeFormat" | "afterFormat" | "all";

export function saveTransformChanges(doc: Text, options: SaveTransformOptions, phase: SaveTransformPhase): ChangeSet {
  let current = doc;
  let total = ChangeSet.empty(doc.length);
  const step = (changes: ChangeSet) => {
    if (changes.empty) return;
    total = total.compose(changes);
    current = changes.apply(current);
  };
  if (phase !== "afterFormat" && options.trimTrailingWhitespace) step(trimTrailingWhitespace(current));
  if (phase !== "beforeFormat") {
    if (options.insertFinalNewline) step(insertFinalNewline(current));
    if (options.trimFinalNewlines) step(trimFinalNewlines(current));
  }
  return total;
}

export function hasSaveTransforms(options: SaveTransformOptions, phase: SaveTransformPhase) {
  const before = options.trimTrailingWhitespace;
  const after = options.insertFinalNewline || options.trimFinalNewlines;
  return phase === "beforeFormat" ? before : phase === "afterFormat" ? after : before || after;
}

export function trimTrailingWhitespace(doc: Text): ChangeSet {
  const changes: ChangeSpec[] = [];
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    if (line.length === 0) continue;
    const last = lastNonWhitespaceIndex(line.text);
    if (last === line.length - 1) continue;
    changes.push({ from: line.from + last + 1, to: line.to });
  }
  return ChangeSet.of(changes, doc.length);
}

export function insertFinalNewline(doc: Text): ChangeSet {
  const last = doc.line(doc.lines);
  if (lastNonWhitespaceIndex(last.text) === -1) return ChangeSet.empty(doc.length);
  return ChangeSet.of({ from: doc.length, insert: "\n" }, doc.length);
}

export function trimFinalNewlines(doc: Text): ChangeSet {
  if (doc.lines === 1) return ChangeSet.empty(doc.length);
  let lastContent = 0;
  for (let number = doc.lines; number >= 1; number--) {
    if (doc.line(number).length > 0) {
      lastContent = number;
      break;
    }
  }
  const from = lastContent + 1 > doc.lines ? doc.length : doc.line(lastContent + 1).from;
  if (from >= doc.length) return ChangeSet.empty(doc.length);
  return ChangeSet.of({ from, to: doc.length }, doc.length);
}

function lastNonWhitespaceIndex(text: string) {
  for (let i = text.length - 1; i >= 0; i--) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9) return i;
  }
  return -1;
}
