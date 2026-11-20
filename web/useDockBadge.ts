import { useEffect } from "react";
import { attentionCount } from "../shared/attention";
import { useStore } from "./store";

// Dock 아이콘 배지에 사람이 봐야 하는 세션 수를 단다(shared/attention.ts 의 기준). 데스크톱 앱에서만 뜻이 있다.
export function useDockBadge() {
  const count = useStore((s) => attentionCount(s.agents, s.feedbacks));
  useEffect(() => {
    void window.agentNavNative?.setBadgeCount?.(count).catch(() => undefined);
  }, [count]);
}
