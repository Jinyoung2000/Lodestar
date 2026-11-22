export type ReplaceRange = { startLine: number; startCol: number; endLine: number; endCol: number };
export type ReplaceEdit = { range: ReplaceRange; expected: string; replacement: string };
export type ReplaceFileRequest = { path: string; edits: ReplaceEdit[] };
export type ReplaceFileResult = { path: string; status: "applied" | "conflict" | "outsideWorkspace" | "notFound" | "error"; applied: number; message?: string };
export type ReplaceQuery = { pattern: string; isRegex: boolean; matchCase: boolean; wholeWord: boolean };

export const REPLACE_MAX_FILES = 10_000;
export const REPLACE_MAX_EDITS_PER_FILE = 50_000;

export function replacementFor(matchText: string, query: ReplaceQuery, replaceText: string, preserveCase: boolean): string {
  return replacementInContext(matchText, null, query, replaceText, preserveCase);
}

export function replacementInContext(matchText: string, contextText: string | null, query: ReplaceQuery, replaceText: string, preserveCase: boolean): string {
  const replacePattern = patternFor(query, replaceText);
  for (const text of contextText === null ? [matchText] : [matchText, contextText]) {
    const found = replacePattern.getReplaceString(text, preserveCase);
    if (found !== null) return found;
    const withoutCr = text.replace(/\r\n/g, "\n");
    if (withoutCr !== text) {
      const foundWithoutCr = replacePattern.getReplaceString(withoutCr, preserveCase);
      if (foundWithoutCr !== null) return foundWithoutCr;
    }
  }
  return replacePattern.pattern;
}

let lastPattern: { key: string; pattern: ReplacePattern } | null = null;

function patternFor(query: ReplaceQuery, replaceText: string): ReplacePattern {
  const key = JSON.stringify([query.pattern, query.isRegex, query.matchCase, query.wholeWord, replaceText]);
  if (lastPattern?.key === key) return lastPattern.pattern;
  const pattern = new ReplacePattern(replaceText, {
    pattern: query.pattern,
    isRegExp: query.isRegex,
    isCaseSensitive: query.matchCase,
    isWordMatch: query.wholeWord,
    isMultiline: isMultilinePattern(query),
  });
  lastPattern = { key, pattern };
  return pattern;
}

function isMultilinePattern(query: ReplaceQuery) {
  return query.pattern.includes("\n") || (query.isRegex && isMultilineRegexSource(query.pattern));
}

function isMultilineRegexSource(source: string) {
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === LINE_FEED) return true;
    if (code === BACKSLASH) {
      i++;
      if (i >= source.length) break;
      const next = source.charCodeAt(i);
      if (next === CODE_N || next === CODE_R || next === CODE_UPPER_W) return true;
    }
  }
  return false;
}

const LINE_FEED = 10;
const BACKSLASH = 92;
const DOLLAR = 36;
const BACKTICK = 96;
const SINGLE_QUOTE = 39;
const CODE_N = 110;
const CODE_T = 116;
const CODE_R = 114;
const CODE_UPPER_W = 87;
const DIGIT_0 = 48;
const DIGIT_1 = 49;
const DIGIT_9 = 57;

export type PatternInfo = { pattern: string; isRegExp?: boolean; isCaseSensitive?: boolean; isWordMatch?: boolean; isMultiline?: boolean };

export class ReplacePattern {
  private replaceString: string;
  private parameters = false;
  private expression: RegExp;
  private caseOpsExpression: RegExp;

  constructor(replaceString: string, searchPatternInfo: PatternInfo);
  constructor(replaceString: string, parseParameters: boolean, regExp: RegExp);
  constructor(replaceString: string, second: PatternInfo | boolean, third?: RegExp) {
    this.replaceString = replaceString;
    let parseParameters: boolean;
    if (typeof second === "boolean") {
      parseParameters = second;
      this.expression = third as RegExp;
    } else {
      parseParameters = !!second.isRegExp;
      this.expression = createRegExp(second.pattern, !!second.isRegExp, { matchCase: second.isCaseSensitive, wholeWord: second.isWordMatch, multiline: second.isMultiline, global: false, unicode: true });
    }
    if (parseParameters) this.parseReplaceString(replaceString);
    if (this.expression.global) {
      this.expression = createRegExp(this.expression.source, true, { matchCase: !this.expression.ignoreCase, wholeWord: false, multiline: this.expression.multiline, global: false });
    }
    this.caseOpsExpression = /([\s\S]*?)((?:\\[uUlL])+?|)(\$[0-9]+)([\s\S]*?)/g;
  }

  get hasParameters() {
    return this.parameters;
  }

  get pattern() {
    return this.replaceString;
  }

  get regExp() {
    return this.expression;
  }

  getReplaceString(text: string, preserveCase?: boolean): string | null {
    this.expression.lastIndex = 0;
    const match = this.expression.exec(text);
    if (!match) return null;
    if (!this.hasParameters) return this.buildReplaceString(match, preserveCase);
    const replaced = this.replaceWithCaseOperations(text, this.expression, this.buildReplaceString(match, preserveCase));
    if (match[0] === text) return replaced;
    return replaced.substr(match.index, match[0].length - (text.length - replaced.length));
  }

  private replaceWithCaseOperations(text: string, regex: RegExp, replaceString: string): string {
    if (!/\\[uUlL]/.test(replaceString)) return text.replace(regex, replaceString);
    const firstMatch = regex.exec(text);
    if (firstMatch === null) return text.replace(regex, replaceString);

    let patMatch: RegExpExecArray | null;
    let next = "";
    let lastIndex = 0;
    let lastMatch = "";
    while ((patMatch = this.caseOpsExpression.exec(replaceString)) !== null) {
      lastIndex = patMatch.index;
      const fullMatch = patMatch[0];
      lastMatch = fullMatch;
      let caseOps = patMatch[2];
      const money = patMatch[3];
      if (!caseOps) {
        next += fullMatch;
        continue;
      }
      const replacement = firstMatch[parseInt(money.slice(1))];
      if (!replacement) {
        next += fullMatch;
        continue;
      }
      const replacementLength = replacement.length;
      next += patMatch[1];
      caseOps = caseOps.replace(/\\/g, "");
      let i = 0;
      for (; i < caseOps.length; i++) {
        switch (caseOps[i]) {
          case "U":
            next += replacement.slice(i).toUpperCase();
            i = replacementLength;
            break;
          case "u":
            next += replacement[i].toUpperCase();
            break;
          case "L":
            next += replacement.slice(i).toLowerCase();
            i = replacementLength;
            break;
          case "l":
            next += replacement[i].toLowerCase();
            break;
        }
      }
      if (i < replacementLength) next += replacement.slice(i);
      next += patMatch[4];
    }
    next += replaceString.slice(lastIndex + lastMatch.length);
    return text.replace(regex, next);
  }

  buildReplaceString(matches: string[] | null, preserveCase?: boolean): string {
    return preserveCase ? buildReplaceStringWithCasePreserved(matches, this.replaceString) : this.replaceString;
  }

  private parseReplaceString(replaceString: string) {
    if (!replaceString || replaceString.length === 0) return;
    let from = 0;
    let result = "";
    for (let i = 0, length = replaceString.length; i < length; i++) {
      const code = replaceString.charCodeAt(i);
      if (code === BACKSLASH) {
        i++;
        if (i >= length) break;
        const nextCode = replaceString.charCodeAt(i);
        let character: string | null = null;
        if (nextCode === BACKSLASH) character = "\\";
        else if (nextCode === CODE_N) character = "\n";
        else if (nextCode === CODE_T) character = "\t";
        if (character) {
          result += replaceString.substring(from, i - 1) + character;
          from = i + 1;
        }
      }
      if (code === DOLLAR) {
        i++;
        if (i >= length) break;
        const nextCode = replaceString.charCodeAt(i);
        let character: string | null = null;
        if (nextCode === DIGIT_0) {
          character = "$&";
          this.parameters = true;
        } else if (nextCode === BACKTICK || nextCode === SINGLE_QUOTE) {
          this.parameters = true;
        } else if (between(nextCode, DIGIT_1, DIGIT_9)) {
          if (i === replaceString.length - 1) {
            this.parameters = true;
          } else {
            let digit = replaceString.charCodeAt(++i);
            if (!between(digit, DIGIT_0, DIGIT_9)) {
              this.parameters = true;
              --i;
            } else if (i === replaceString.length - 1) {
              this.parameters = true;
            } else {
              digit = replaceString.charCodeAt(++i);
              if (!between(digit, DIGIT_0, DIGIT_9)) {
                this.parameters = true;
                --i;
              }
            }
          }
        }
        if (character) {
          result += replaceString.substring(from, i - 1) + character;
          from = i + 1;
        }
      }
    }
    if (from === 0) return;
    this.replaceString = result + replaceString.substring(from);
  }
}

function between(value: number, from: number, to: number) {
  return from <= value && value <= to;
}

type RegExpOptions = { matchCase?: boolean; wholeWord?: boolean; multiline?: boolean; global?: boolean; unicode?: boolean };

function createRegExp(searchString: string, isRegex: boolean, options: RegExpOptions): RegExp {
  if (!searchString) throw new Error("Cannot create regex from empty string");
  let source = searchString;
  if (!isRegex) source = source.replace(/[\\{}*+?|^$.[\]()]/g, "\\$&");
  if (options.wholeWord) {
    if (!/\B/.test(source.charAt(0))) source = `\\b${source}`;
    if (!/\B/.test(source.charAt(source.length - 1))) source = `${source}\\b`;
  }
  let modifiers = "";
  if (options.global) modifiers += "g";
  if (!options.matchCase) modifiers += "i";
  if (options.multiline) modifiers += "m";
  if (options.unicode) modifiers += "u";
  return new RegExp(source, modifiers);
}

export function buildReplaceStringWithCasePreserved(matches: string[] | null, pattern: string): string {
  if (!matches || matches[0] === "") return pattern;
  const containsHyphens = hasSeparator(matches, pattern, "-");
  const containsUnderscores = hasSeparator(matches, pattern, "_");
  if (containsHyphens && !containsUnderscores) return buildForSeparator(matches, pattern, "-");
  if (!containsHyphens && containsUnderscores) return buildForSeparator(matches, pattern, "_");
  if (matches[0].toUpperCase() === matches[0]) return pattern.toUpperCase();
  if (matches[0].toLowerCase() === matches[0]) return pattern.toLowerCase();
  if (containsUppercase(matches[0][0]) && pattern.length > 0) return pattern[0].toUpperCase() + pattern.slice(1);
  if (matches[0][0].toUpperCase() !== matches[0][0] && pattern.length > 0) return pattern[0].toLowerCase() + pattern.slice(1);
  return pattern;
}

function hasSeparator(matches: string[], pattern: string, separator: string) {
  const both = matches[0].indexOf(separator) !== -1 && pattern.indexOf(separator) !== -1;
  return both && matches[0].split(separator).length === pattern.split(separator).length;
}

function buildForSeparator(matches: string[], pattern: string, separator: string) {
  const patternParts = pattern.split(separator);
  const matchParts = matches[0].split(separator);
  let result = "";
  patternParts.forEach((part, index) => {
    result += buildReplaceStringWithCasePreserved([matchParts[index]], part) + separator;
  });
  return result.slice(0, -1);
}

function containsUppercase(target: string) {
  return !!target && target.toLowerCase() !== target;
}
