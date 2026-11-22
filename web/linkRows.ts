import type { LinkAction } from "../shared/linkIntent";
import type { SimulatorDevice } from "../shared/simulator";
import { S } from "./strings";

export type SimulatorState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; devices: SimulatorDevice[] };

export type LinkRowRun = { kind: "browser"; url: string } | { kind: "simulator"; url: string; udid: string };
export type LinkRow = { key: string; title: string; detail: string; run: LinkRowRun | null };

export const needsSimulator = (actions: readonly LinkAction[]) => actions.some((action) => action.kind !== "browser");

export function linkRows(actions: readonly LinkAction[], simulator: SimulatorState | null): LinkRow[] {
  return actions.flatMap((action): LinkRow[] => {
    if (action.kind === "browser") return [{ key: `browser:${action.url}`, title: S.linkOpenBrowser, detail: action.url, run: { kind: "browser", url: action.url } }];
    const label = action.kind === "simulator" ? S.linkOpenSimulator : S.linkOpenSimulatorWebview;
    const detail = action.kind === "simulator" ? action.url : action.remote;
    if (!simulator || simulator.status === "loading") return [{ key: `${action.kind}:loading`, title: label, detail: S.linkCheckingSimulators, run: null }];
    if (simulator.status === "error") return [{ key: `${action.kind}:error`, title: label, detail: S.linkSimulatorListFailed(simulator.message), run: null }];
    if (simulator.devices.length === 0) return [{ key: `${action.kind}:none`, title: label, detail: S.linkNoBootedSimulator, run: null }];
    return simulator.devices.map((device) => ({
      key: `${action.kind}:${device.udid}`,
      title: S.linkOnDevice(label, device.name),
      detail,
      run: { kind: "simulator", url: action.url, udid: device.udid },
    }));
  });
}
