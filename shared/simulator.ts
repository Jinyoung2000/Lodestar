
export type SimulatorDevice = { udid: string; name: string };

export type SimulatorRpcMethods = {
  "simulator.devices": { params: Record<string, never>; result: SimulatorDevice[] };
  "simulator.openUrl": { params: { url: string; udid?: string }; result: null };
};
