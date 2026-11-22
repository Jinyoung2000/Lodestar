import { useEffect } from "react";
import { attentionCount } from "../shared/attention";
import { useStore } from "./store";

export function useDockBadge() {
  const count = useStore((s) => attentionCount(s.agents, s.feedbacks));
  useEffect(() => {
    void window.agentNavNative?.setBadgeCount?.(count).catch(() => undefined);
  }, [count]);
}
