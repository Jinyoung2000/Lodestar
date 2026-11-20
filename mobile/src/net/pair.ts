// 페어링: 데몬의 POST /mobile/pair 에 일회용 코드를 보내 이 기기의 장치 토큰을 받는다.
// 주소 후보가 여럿이면(Wi-Fi, Tailscale 등) 동시에 시도해 먼저 응답한 주소를 쓴다. 코드가 틀린 응답(401, 429)은 곧바로 이유를 돌려준다.
import type { PairResult } from "@shared/mobile";
import type { PairingInfo } from "../logic/pairing";

export type PairOutcome = { ok: true; result: PairResult; host: string } | { ok: false; reason: "rejected" | "unreachable"; message: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function pairWithHost(info: PairingInfo, deviceName: string, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<PairOutcome> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const controllers: AbortController[] = [];
  const attempts = info.hosts.map(async (host) => {
    const controller = new AbortController();
    controllers.push(controller);
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
    try {
      const response = await doFetch(`http://${host}:${info.port}/mobile/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: info.code, deviceName }), signal: controller.signal });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 200 && typeof body.deviceToken === "string") return { kind: "ok" as const, host, result: body as unknown as PairResult };
      return { kind: "rejected" as const, message: typeof body.error === "string" ? body.error : `The Mac answered ${response.status}` };
    } catch {
      return { kind: "unreachable" as const };
    } finally {
      clearTimeout(timer);
    }
  });
  // 먼저 성공한 주소가 이긴다. 코드는 한 번 쓰면 폐기되므로 같은 Mac 의 다른 주소(Wi-Fi 와 Tailscale)는 거절을 받는다. 그 거절이 성공보다 먼저 도착해도
  // 성공을 버리지 않게, 거절은 모든 주소가 끝난 뒤에 돌려준다. 전부 닿지 않으면 unreachable.
  const settled = await new Promise<PairOutcome>((resolve) => {
    let pending = attempts.length;
    let rejected: string | null = null;
    for (const attempt of attempts) {
      void attempt.then((outcome) => {
        if (outcome.kind === "ok") return resolve({ ok: true, result: outcome.result, host: outcome.host });
        if (outcome.kind === "rejected") rejected ??= outcome.message;
        if (--pending > 0) return;
        if (rejected !== null) resolve({ ok: false, reason: "rejected", message: rejected });
        else resolve({ ok: false, reason: "unreachable", message: "Could not reach your Mac. Check that this phone is on the same Wi-Fi and Mobile access is on." });
      });
    }
  });
  for (const controller of controllers) controller.abort();
  return settled;
}
