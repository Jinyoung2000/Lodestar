// CMDT: 시뮬레이터 RPC(server/simulator.ts) 시험. 가짜 실행기로 인자 배열과 거절을, 가짜 xcrun 스크립트로 실제 execFile 경로를 본다. 실행: npm test
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOBILE_METHODS } from "../shared/mobile";
import { guardMobileCall } from "../server/mobileAccess";
import { DEVICES_ARGS, openUrlArgs, parseBooted, simulatorHandlers, type Run } from "../server/simulator";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

const IPHONE = "C0CDE4C7-4BD5-4B5F-8215-9BC537663395";
const IPAD = "AAAAAAAA-1111-4222-8333-444444444444";
const LIST = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      { udid: IPHONE, name: "iPhone 17", state: "Booted" },
      { udid: "BBBBBBBB-1111-4222-8333-444444444444", name: "iPhone 16", state: "Shutdown" },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: IPAD, name: "iPad Pro", state: "Booted" }],
  },
});

// 순수 부분
check("parseBooted: Booted 만, 이름순", same(parseBooted(LIST), [{ udid: IPAD, name: "iPad Pro" }, { udid: IPHONE, name: "iPhone 17" }].sort((a, b) => a.name.localeCompare(b.name))));
check("parseBooted: 켜진 기기가 없으면 빈 배열", same(parseBooted(JSON.stringify({ devices: { a: [] } })), []) && same(parseBooted("{}"), []));
let parseError = "";
try {
  parseBooted("not json");
} catch (error) {
  parseError = (error as Error).message;
}
check("parseBooted: JSON 이 아니면 오류", parseError === "Could not read the simulator list");
check("인자는 배열이고 주소는 한 칸", same(openUrlArgs("booted", "karrot.alpha://a b;c"), ["simctl", "openurl", "booted", "karrot.alpha://a b;c"]));
check("기기 목록 인자", same(DEVICES_ARGS, ["simctl", "list", "devices", "booted", "--json"]));

// 가짜 실행기로 핸들러
{
  const calls: { file: string; args: string[] }[] = [];
  const run: Run = async (file, args) => {
    calls.push({ file, args });
    return args[1] === "list" ? LIST : "";
  };
  const handlers = simulatorHandlers(run);
  const devices = await handlers["simulator.devices"]({});
  check("devices: 켜진 기기 둘", devices.length === 2 && devices.some((d) => d.udid === IPHONE));
  check("devices 호출 인자", same(calls[0], { file: "xcrun", args: ["simctl", "list", "devices", "booted", "--json"] }));

  calls.length = 0;
  await handlers["simulator.openUrl"]({ url: "karrot.alpha://", udid: IPHONE });
  check("openUrl: udid 를 그대로 넣은 배열", same(calls[0], { file: "xcrun", args: ["simctl", "openurl", IPHONE, "karrot.alpha://"] }));
  check("openUrl: 이어서 Simulator 를 앞으로(open -a Simulator)", same(calls[1], { file: "open", args: ["-a", "Simulator"] }) && calls.length === 2);

  calls.length = 0;
  await handlers["simulator.openUrl"]({ url: "karrot://home" });
  check("udid 가 없으면 booted", calls[0].args[2] === "booted");

  calls.length = 0;
  const bad: [string, { url: string; udid?: string }][] = [
    ["https 주소", { url: "https://example.com" }],
    ["file 주소", { url: "file:///etc/passwd" }],
    ["공백이 든 주소", { url: "karrot://a b" }],
    ["줄바꿈이 든 주소", { url: "karrot://a\n--help" }],
    ["빈 주소", { url: "" }],
    ["옵션처럼 보이는 주소", { url: "-karrot://a" }],
    ["udid 가 옵션", { url: "karrot://a", udid: "--help" }],
    ["udid 가 UUID 가 아님", { url: "karrot://a", udid: "booted; rm -rf /" }],
  ];
  for (const [name, params] of bad) {
    const message = await rejects(() => handlers["simulator.openUrl"](params));
    check(`openUrl 거절: ${name}`, message !== null, message ?? "통과해 버림");
  }
  check("거절된 요청은 아무것도 실행하지 않는다", calls.length === 0);

  // 앞으로 가져오기 실패는 삼키고 주소 열기는 성공으로 본다
  const flaky: Run = async (file) => {
    if (file === "open") throw new Error("no window server");
    return "";
  };
  check("open 실패는 무시", (await rejects(() => simulatorHandlers(flaky)["simulator.openUrl"]({ url: "karrot://home" }))) === null);

  // xcrun 실패는 그대로 오류가 된다
  const broken: Run = async () => {
    throw new Error("Unable to find a booted device");
  };
  check("xcrun 실패는 오류로 전달", (await rejects(() => simulatorHandlers(broken)["simulator.openUrl"]({ url: "karrot://home" }))) === "Unable to find a booted device");
}

// 가짜 xcrun 스크립트로 진짜 execFile 경로(셸 해석 없음, 환경 변수로 실행 파일 지정)
{
  const dir = mkdtempSync(join(tmpdir(), "cmdt-sim-"));
  const log = join(dir, "calls.log");
  const fake = join(dir, "xcrun");
  const fakeOpen = join(dir, "open");
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a" >> "${log}"; done\nprintf '\\n' >> "${log}"\nif [ "$2" = "list" ]; then cat <<'JSON'\n${LIST}\nJSON\nfi\n`);
  writeFileSync(fakeOpen, `#!/bin/sh\nprintf 'OPEN' >> "${log}"; for a in "$@"; do printf '[%s]' "$a" >> "${log}"; done\nprintf '\\n' >> "${log}"\n`);
  chmodSync(fake, 0o755);
  chmodSync(fakeOpen, 0o755);
  const saved = { x: process.env.AGENT_NAV_XCRUN, o: process.env.AGENT_NAV_OPEN_BIN };
  process.env.AGENT_NAV_XCRUN = fake;
  process.env.AGENT_NAV_OPEN_BIN = fakeOpen;
  try {
    const handlers = simulatorHandlers();
    const devices = await handlers["simulator.devices"]({});
    check("가짜 xcrun: 기기 목록", devices.length === 2);
    await handlers["simulator.openUrl"]({ url: "karrot.alpha://minikarrot/router?remote=http%3A%2F%2Flocalhost%3A3000%2F&navbar=false&scrollable=false", udid: IPHONE });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    check("가짜 xcrun: 주소가 인자 하나로 통째로 도착", lines[1] === `[simctl][openurl][${IPHONE}][karrot.alpha://minikarrot/router?remote=http%3A%2F%2Flocalhost%3A3000%2F&navbar=false&scrollable=false]`, lines[1]);
    check("가짜 open: -a Simulator", lines[2] === "OPEN[-a][Simulator]", lines[2]);
    // 셸 메타문자가 든 허용 scheme 주소도 인자 하나로만 간다(셸이 없으므로 실행되지 않는다)
    writeFileSync(log, "");
    await handlers["simulator.openUrl"]({ url: "karrot://home;touch${IFS}/tmp/cmdt-pwned&&$(id)`id`|cat" });
    const injected = readFileSync(log, "utf8").trim().split("\n")[0];
    check("셸 메타문자는 인자 안에만 머문다", injected === "[simctl][openurl][booted][karrot://home;touch${IFS}/tmp/cmdt-pwned&&$(id)`id`|cat]", injected);
    process.env.AGENT_NAV_XCRUN = join(dir, "does-not-exist");
    const missing = await rejects(() => handlers["simulator.devices"]({}));
    check("xcrun 이 없으면 not found 오류", !!missing && missing.endsWith("not found"), missing ?? "");
  } finally {
    if (saved.x === undefined) delete process.env.AGENT_NAV_XCRUN;
    else process.env.AGENT_NAV_XCRUN = saved.x;
    if (saved.o === undefined) delete process.env.AGENT_NAV_OPEN_BIN;
    else process.env.AGENT_NAV_OPEN_BIN = saved.o;
    rmSync(dir, { recursive: true, force: true });
  }
}

// 모바일 허용 목록에 없다
check("MOBILE_METHODS 에 simulator.* 없음", !(MOBILE_METHODS as readonly string[]).some((m) => m.startsWith("simulator.")));
for (const method of ["simulator.openUrl", "simulator.devices"]) {
  const message = await rejects(async () => guardMobileCall(method, { url: "karrot://home" }));
  check(`모바일 가드가 ${method} 를 거절`, message !== null, message ?? "통과해 버림");
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
