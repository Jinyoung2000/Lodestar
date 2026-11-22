import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAILURE_KEY_VERSION = 2;

export type CheckFailure = { key: string; text: string };
export type CheckOutcome = { ok: boolean; failures: CheckFailure[]; output: string };

export function tscFailures(output: string): CheckFailure[] {
  const found: CheckFailure[] = [];
  let open = false;
  for (const raw of output.split("\n")) {
    const match = /^(?:(.+?)\(\d+,\d+\): )?error (TS\d+): (.*)$/.exec(raw);
    if (match) {
      found.push({ key: `${match[1] ?? ""} ${match[2]} ${match[3].trim()}`, text: raw.trim() });
      open = true;
    } else if (open && /^\s+\S/.test(raw)) {
      const last = found[found.length - 1];
      last.key += ` ${raw.trim()}`;
      last.text += `\n${raw.trimEnd()}`;
    } else open = false;
  }
  if (found.length) return found;
  const line = firstLine(output);
  return [{ key: `tsc ${normalize(line)}`, text: line }];
}

export function testFailures(scope: string, output: string, known: string[] = []): CheckFailure[] {
  const names = output
    .split("\n")
    .map((line) => /^FAIL (.*)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ key: `${scope}: ${testNameOf(m[1], known)}`, text: `${scope}: FAIL ${m[1]}` }));
  if (names.length) return names;
  const last = lastLine(output);
  return [{ key: `${scope}: crashed ${normalize(last)}`, text: `${scope}: ${last || "exited with an error"}` }];
}

export function quotedStrings(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)+)"|'((?:[^'\\\n]|\\.)+)'|`((?:[^`\\$]|\\.)+)`/g)) {
    const text = (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, "$1");
    if (text.includes(": ") && text.length > 8) found.add(text);
  }
  return [...found];
}

function testNameOf(rest: string, known: string[]) {
  let best = "";
  for (const name of known) {
    const boundary = rest.length === name.length || rest.startsWith(`${name}:`) || rest.startsWith(`${name} (`);
    if (rest.startsWith(name) && boundary && name.length > best.length) best = name;
  }
  if (best) return best;
  const cut = rest.indexOf(": ");
  const name = cut === -1 ? rest : rest.slice(0, cut);
  return name.replace(/\s*\([^()]*\)\s*$/, "");
}

export function plainFailures(name: string, output: string): CheckFailure[] {
  return [{ key: `${name} failed`, text: `${name} failed: ${lastLine(output) || "no output"}` }];
}

export function newFailures(current: CheckFailure[], base: CheckFailure[]): CheckFailure[] {
  const left = new Map<string, number>();
  for (const failure of base) left.set(failure.key, (left.get(failure.key) ?? 0) + 1);
  const fresh: CheckFailure[] = [];
  for (const failure of current) {
    const n = left.get(failure.key) ?? 0;
    if (n > 0) left.set(failure.key, n - 1);
    else fresh.push(failure);
  }
  return fresh;
}

export function baselineKey(baseline: Record<string, string>): string {
  const hash = createHash("sha1");
  hash.update(`failure-key-v${FAILURE_KEY_VERSION}\n`);
  for (const rel of Object.keys(baseline).sort()) hash.update(`${rel}\0${baseline[rel]}\n`);
  return hash.digest("hex");
}

export function readBaselineCache(dir: string, key: string): Record<string, CheckOutcome> {
  try {
    return JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as Record<string, CheckOutcome>;
  } catch {
    return {};
  }
}

export function writeBaselineCache(dir: string, key: string, check: string, outcome: CheckOutcome) {
  mkdirSync(dir, { recursive: true });
  const all = { ...readBaselineCache(dir, key), [check]: outcome };
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(all));
}

function firstLine(text: string) {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

function lastLine(text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 200);
}

function normalize(line: string) {
  return line.replace(/\/(?:private\/)?(?:var|tmp)\/\S+/g, "<tmp>").replace(/\d+/g, "#");
}
