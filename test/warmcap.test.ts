import { selectWarmEvictions, type WarmCandidate } from "../server/warmCap";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const idle = (agentId: string, lastUsed: number): WarmCandidate => ({ agentId, lastUsed, busy: false });
const busy = (agentId: string, lastUsed: number): WarmCandidate => ({ agentId, lastUsed, busy: true });

check("한도 안이면 아무것도 닫지 않는다", selectWarmEvictions([idle("a", 1), idle("b", 2), idle("c", 3)], 3).length === 0);
check("넘친 만큼 가장 오래전에 쓴 것부터 닫는다", selectWarmEvictions([idle("a", 1), idle("b", 5), idle("c", 3), idle("d", 4)], 2).join() === "c,a");
check("한도 0 은 한도 없음", selectWarmEvictions([idle("a", 1), idle("b", 2)], 0).length === 0);
check("음수와 NaN 도 한도 없음", selectWarmEvictions([idle("a", 1), idle("b", 2)], -1).length === 0 && selectWarmEvictions([idle("a", 1)], Number.NaN).length === 0);
check("턴이 도는 세션은 한도에 세지 않고 닫지도 않는다", selectWarmEvictions([busy("run1", 0), busy("run2", 0), idle("a", 1), idle("b", 2)], 2).length === 0);
check("도는 세션이 가장 오래돼도 쉬는 세션만 닫는다", selectWarmEvictions([busy("run", 0), idle("a", 3), idle("b", 2), idle("c", 1)], 2).join() === "c");
check("입력 순서와 상관없이 쓴 시각으로 정한다", selectWarmEvictions([idle("new", 9), idle("old", 1), idle("mid", 5)], 1).join() === "mid,old");
check("후보를 바꾸지 않는다", (() => {
  const list = [idle("a", 1), idle("b", 2)];
  selectWarmEvictions(list, 1);
  return list[0].agentId === "a";
})());

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
