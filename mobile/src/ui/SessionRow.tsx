import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, SessionSort } from "@shared/protocol";
import { stateOf } from "../logic/agents";
import { relativeTime } from "../logic/time";
import { MIN_TOUCH, spacing, useColors } from "../theme/theme";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";
import { Text } from "./Text";

// 세션 목록의 한 줄(세션 탭과 워크스페이스 화면이 같이 쓴다). 고정한 세션은 시간 옆에 핀 표시가 붙는다.
// time 은 오른쪽에 보이는 시각의 기준: 기본은 마지막 수정(updated), 프로젝트 화면이 만든 순으로 정렬했을 때는 만든 시각(created)을 보인다.
export const SessionRow = memo(function SessionRow({ agent, subtitle, time = "updated", onPress, onLongPress }: { agent: Agent; subtitle: string; time?: SessionSort; onPress: (id: string) => void; onLongPress: (agent: Agent) => void }) {
  const colors = useColors();
  const state = stateOf(agent);
  const detail = state === "waiting" ? "Needs your reply" : state === "error" ? "Something went wrong" : subtitle;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${agent.title}, ${subtitle}, ${state === "idle" ? "idle" : state}${agent.pinned ? ", pinned" : ""}${agent.done ? ", done" : ""}`}
      onPress={() => onPress(agent.id)}
      onLongPress={() => onLongPress(agent)}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : "transparent", borderBottomColor: colors.separator }]}
    >
      <StatusDot state={state} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="title" color={agent.unread ? "textStrong" : "text"} numberOfLines={1} style={{ fontWeight: agent.unread || state === "waiting" ? "700" : "500" }}>
          {agent.title}
        </Text>
        <Text variant="secondary" color={state === "waiting" ? "warning" : state === "error" ? "danger" : "textMuted"} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {agent.pinned && <Icon name="pin" size={12} color="textSubtle" />}
      <Text variant="secondary" color="textSubtle">{relativeTime(time === "created" ? agent.createdAt : agent.updatedAt)}</Text>
      <Icon name="chevron.right" size={13} color="textSubtle" />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: Math.max(68, MIN_TOUCH), paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
});
