import { execFile } from "node:child_process";
import type { SimulatorDevice, SimulatorRpcMethods } from "../shared/simulator";
import { simulatorUrlOk } from "../shared/linkIntent";

// CMDT: ⌘T 입력창의 링크 실행 중 시뮬레이터 쪽. 인자는 항상 배열로 execFile 에 넘기고 셸을 거치지 않는다.
// 열 수 있는 주소는 shared/linkIntent.ts 의 SIMULATOR_SCHEMES 둘뿐이다(임의 명령 실행 통로가 되지 않게 여기서 다시 거른다).

const RUN_TIMEOUT_MS = 15_000;
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export type Run = (file: string, args: string[]) => Promise<string>;
type Handlers = { [M in keyof SimulatorRpcMethods]: (params: SimulatorRpcMethods[M]["params"]) => Promise<SimulatorRpcMethods[M]["result"]> };

// 시험이 가짜 실행 파일로 바꿔 끼울 수 있게 환경 변수로 경로를 받는다.
export function simulatorHandlers(run: Run = runFile): Handlers {
  return {
    "simulator.devices": async () => parseBooted(await run(xcrunBin(), DEVICES_ARGS)),
    "simulator.openUrl": async ({ url, udid }) => {
      if (!simulatorUrlOk(url)) throw new Error("Only karrot:// and karrot.alpha:// links can be opened in the simulator");
      if (udid !== undefined && (typeof udid !== "string" || !UDID.test(udid))) throw new Error("Invalid simulator id");
      await run(xcrunBin(), openUrlArgs(udid ?? "booted", url));
      // 사용자가 직접 고른 실행이라 Simulator 창을 앞으로 가져온다. 실패해도 주소는 이미 열렸다.
      await run(openBin(), ["-a", "Simulator"]).catch(() => "");
      return null;
    },
  };
}

export const DEVICES_ARGS = ["simctl", "list", "devices", "booted", "--json"];

export function openUrlArgs(udid: string, url: string): string[] {
  return ["simctl", "openurl", udid, url];
}

// `xcrun simctl list devices booted --json` 의 출력에서 Booted 기기만 이름순으로.
export function parseBooted(text: string): SimulatorDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Could not read the simulator list");
  }
  const groups = (parsed as { devices?: Record<string, unknown> } | null)?.devices;
  if (!groups || typeof groups !== "object") return [];
  const found: SimulatorDevice[] = [];
  for (const list of Object.values(groups)) {
    if (!Array.isArray(list)) continue;
    for (const item of list as { udid?: unknown; name?: unknown; state?: unknown }[]) {
      if (item?.state === "Booted" && typeof item.udid === "string" && typeof item.name === "string") found.push({ udid: item.udid, name: item.name });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
}

const xcrunBin = () => process.env.AGENT_NAV_XCRUN || "xcrun";
const openBin = () => process.env.AGENT_NAV_OPEN_BIN || "open";

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = String(stderr || "").trim().split("\n")[0];
      reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? `${file} not found` : detail || error.message));
    });
  });
}
