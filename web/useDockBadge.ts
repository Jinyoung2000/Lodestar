import { useEffect } from "react";
import { attentionCount } from "../shared/attention";
import { localNative } from "./remote";
import { useStore } from "./store";

export function useDockBadge() {
  const count = useStore((s) => attentionCount(s.agents, s.feedbacks));
  useEffect(() => {
    void localNative()?.setBadgeCount?.(count).catch(() => undefined);
  }, [count]);
}
