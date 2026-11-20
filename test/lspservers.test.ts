// web/lspServers.ts 시험: 에디터 상태 표시 요약("TS 7.0 + Relay")과 실패한 보조 서버 목록.
// 실행: npm test
import { failedServers, lspSummary, shortTypescriptLabel } from "../web/lspServers";
import type { LspServerState } from "../web/store";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const ts: LspServerState = { key: "typescript", id: "typescript", label: "TypeScript", primary: true, state: "ready", dir: null };
const relay = (state: LspServerState["state"], reason?: string): LspServerState => ({ key: "relay:/ws/app", id: "relay", label: "Relay", primary: false, state, dir: "/ws/app", ...(reason ? { reason } : {}) });

check("라벨 줄이기: 네이티브", shortTypescriptLabel("TypeScript 7.0.2 (native)") === "TS 7.0");
check("라벨 줄이기: 번들은 출처를 남김", shortTypescriptLabel("TypeScript 5.9.3 (bundled)") === "TS 5.9 (bundled)");
check("라벨 줄이기: 모르는 형식은 그대로", shortTypescriptLabel("Something") === "Something");
check("요약: 보조 서버가 없으면 주 서버 라벨 그대로", lspSummary("TypeScript 7.0.2 (native)", [ts, relay("idle")]) === "TypeScript 7.0.2 (native)");
check("요약: Relay 가 뜨면 TS 7.0 + Relay", lspSummary("TypeScript 7.0.2 (native)", [ts, relay("ready")]) === "TS 7.0 + Relay");
check("요약: 뜨는 중과 실패는 괄호", lspSummary("TypeScript 7.0.2 (native)", [ts, relay("starting")]) === "TS 7.0 + Relay (starting)" && lspSummary("TypeScript 7.0.2 (native)", [ts, relay("failed")]) === "TS 7.0 + Relay (failed)");
check("요약: 주 서버 라벨을 아직 모르면 서버 목록의 라벨", lspSummary(undefined, [ts, relay("ready")]) === "TypeScript + Relay");
check("요약: 서버 목록이 없으면 주 서버 라벨", lspSummary("TypeScript 5.9.3 (bundled)", undefined) === "TypeScript 5.9.3 (bundled)" && lspSummary(undefined, undefined) === undefined);
check("실패 목록: 보조 서버의 failed 만, 이유와 함께", JSON.stringify(failedServers([ts, relay("failed", "Relay needs watchman (brew install watchman).")])) === '[{"label":"Relay","reason":"Relay needs watchman (brew install watchman)."}]');
check("실패 목록: 정상이면 비어 있음", failedServers([ts, relay("ready")]).length === 0 && failedServers(undefined).length === 0);

console.log(failed === 0 ? "all passed" : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
