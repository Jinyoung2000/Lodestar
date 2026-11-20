import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// CHKBASE: 피드백 검사 실패가 피드백 탓인지 가르는 순수 함수와 기준선 결과 캐시.
// 기준선 = 같은 검사를 피드백 변경을 뺀 파일들(baseline.json 의 blob)에서 돌린 결과.

const FAILURE_KEY_VERSION = 2;

export type CheckFailure = { key: string; text: string };
export type CheckOutcome = { ok: boolean; failures: CheckFailure[]; output: string };

// tsc 오류는 파일, 코드, 문구로 비교한다. 줄 번호는 키에서 뺀다. 피드백이 같은 파일의 위쪽을 고치면 기존 오류의 줄이 밀려서 새 오류로 보이기 때문이다.
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

// 시험 파일 하나의 출력에서 "FAIL 이름..." 줄을 이름으로 뽑는다. 줄 모양은 시험마다 달라 "FAIL 이름: 오류", "FAIL 이름 (상세)", "FAIL 이름"(다음 줄에 오류)이 섞여 있다.
// 오류와 상세에는 임시 경로, 시각, 숫자가 들어 실행마다 달라지므로 키는 이름만 쓴다. 같은 시험이 다른 오류 문구로 떨어져도 같은 실패다.
// known: 시험 파일에 적힌 문자열(시험 이름 후보). 이름에 ": " 가 들어 있으면 가장 긴 후보로 이름 끝을 정하고, 없으면 첫 ": " 앞까지를 이름으로 본다.
// FAIL 줄 없이 죽었으면(예외, 타임아웃) 마지막 줄을 숫자와 임시 경로를 지워 키로 쓴다.
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

// 시험 파일의 소스에서 시험 이름 후보(따옴표 문자열)를 모은다. 보간이 있는 템플릿 문자열은 이름이 고정이 아니라 뺀다.
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

// 성공 또는 실패만 보는 검사(build 등).
export function plainFailures(name: string, output: string): CheckFailure[] {
  return [{ key: `${name} failed`, text: `${name} failed: ${lastLine(output) || "no output"}` }];
}

// 현재 실패 중 기준선에 없던 것. 같은 키는 개수까지 세어서, 기준선보다 늘어난 만큼만 새 실패다.
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

// 기준 상태가 같으면 같은 키. 파일 경로와 blob 해시 전체로 만든다.
export function baselineKey(baseline: Record<string, string>): string {
  const hash = createHash("sha1");
  // 실패 키의 형식이 바뀌면 옛 캐시의 키와 새 키가 어긋나 기존 실패가 새 실패로 보인다. 형식을 바꿀 때 올린다.
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
