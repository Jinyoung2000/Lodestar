// CMDT: ⌘T 입력창의 "Open in Simulator" 가 부르는 데몬 RPC 타입. 모바일 허용 목록(shared/mobile.ts)에는 넣지 않는다.

export type SimulatorDevice = { udid: string; name: string };

export type SimulatorRpcMethods = {
  // 켜진(Booted) 시뮬레이터 기기들. xcrun 이 없거나 실패하면 오류.
  "simulator.devices": { params: Record<string, never>; result: SimulatorDevice[] };
  // karrot, karrot.alpha 주소 하나를 켜진 기기에서 연다. udid 가 없으면 simctl 의 booted.
  "simulator.openUrl": { params: { url: string; udid?: string }; result: null };
};
