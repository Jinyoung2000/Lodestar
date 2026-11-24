import type { MobileDevices } from "./mobileAccess";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const TIMEOUT_MS = 10_000;

export type PushMessage = { title: string; body: string; agentId?: string };
type Ticket = { status?: string; details?: { error?: string } };

export type MobilePushDeps = {
  devices: Pick<MobileDevices, "list" | "setPush">;
  blocked?: () => boolean;
  url?: string;
  post?: (url: string, body: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
};

export class MobilePush {
  constructor(private deps: MobilePushDeps) {}

  async send(message: PushMessage): Promise<number> {
    if (this.deps.blocked?.()) return 0;
    const targets = this.deps.devices.list().filter((device) => typeof device.pushToken === "string" && PUSH_TOKEN_RE.test(device.pushToken));
    if (targets.length === 0) return 0;
    const payload = targets.map((device) => ({ to: device.pushToken, title: message.title, body: message.body, sound: "default", ...(message.agentId ? { data: { agentId: message.agentId } } : {}) }));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const post = this.deps.post ?? ((url, body, signal) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body, signal }));
      const response = await post(this.deps.url ?? EXPO_PUSH_URL, JSON.stringify(payload), abort.signal);
      if (!response.ok) {
        console.error(`[push] the push service answered ${response.status}`);
        return 0;
      }
      const result = (await response.json()) as { data?: Ticket[] } | null;
      const tickets = Array.isArray(result?.data) ? result.data : [];
      let sent = 0;
      tickets.forEach((ticket, index) => {
        if (ticket.status === "ok") sent++;
        else if (ticket.details?.error === "DeviceNotRegistered" && targets[index]) this.deps.devices.setPush(targets[index].id, null);
      });
      console.log(`[push] sent ${sent} of ${targets.length}`);
      return sent;
    } catch (error) {
      console.error(`[push] could not reach the push service: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      clearTimeout(timer);
    }
  }
}
