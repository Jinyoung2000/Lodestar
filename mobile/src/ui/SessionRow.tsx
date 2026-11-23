import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, SessionSort } from "@shared/protocol";
import { stateOf, type SessionState } from "../logic/agents";
import { relativeTime } from "../logic/time";
import { spacing, useColors, withAlpha } from "../theme/theme";
import { ProjectIcon } from "./ProjectIcon";
import { ProviderLabel, ProviderMark, sessionIdentity } from "./ProviderMark";
import { Text } from "./Text";

type RowActions = { agent: Agent; selected?: boolean; onPress: (id: string) => void; onLongPress: (agent: Agent) => void };

export const SessionRow = memo(function SessionRow({ agent, selected, subtitle, time = "updated", onPress, onLongPress }: RowActions & { subtitle: string; time?: SessionSort }) {
  const state = stateOf(agent);
  const queued = agent.queue?.filter((message) => !message.sent).length ?? 0;
  const queuedLabel = queued ? `${queued} queued` : null;
  return <SessionRowFrame agent={agent} selected={selected} state={state} stamp={relativeTime(time === "created" ? agent.createdAt : agent.updatedAt)}
    emphasized={!!agent.unread || state === "waiting"} detailsLabel={[queuedLabel, subtitle].filter(Boolean).join(", ")} showPin onPress={onPress} onLongPress={onLongPress}>
    <ProviderLabel workspaceId={subtitle ? agent.workspaceId : null} parts={[subtitle, queuedLabel]} state={state} />
  </SessionRowFrame>;
});

export function SessionRowFrame({ agent, selected, state, stamp, emphasized, showPin, detailsLabel, children, onPress, onLongPress }: RowActions & {
  state: SessionState; stamp: string; emphasized: boolean; showPin?: boolean; detailsLabel?: string; children: ReactNode;
}) {
  const colors = useColors();
  const unread = showPin && !!agent.unread;
  return <Pressable accessibilityRole="button" accessibilityLabel={[agent.title, sessionIdentity(agent.harness, state), agent.pinned ? "Pinned" : null, agent.done ? "Done" : null, detailsLabel, stamp].filter(Boolean).join(", ")} accessibilityState={selected === undefined ? undefined : { selected }} accessibilityHint="Long press for more actions"
    onPress={() => onPress(agent.id)} onLongPress={() => onLongPress(agent)}
    style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : selected ? colors.selected : colors.background }]}>
    {({ pressed }) => <>
      {state === "waiting" && !selected && !pressed && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.warning, 0.14) }]} />}
      <View style={styles.line}>
        <View style={styles.mark}><ProviderMark harness={agent.harness} size={16} /></View>
        <Text color={showPin && agent.done ? "textMuted" : emphasized ? "textStrong" : "text"} numberOfLines={1} style={[styles.title, emphasized && styles.strong]}>{agent.title}</Text>
        {showPin && agent.pinned && <View accessibilityLabel="Pinned" style={styles.pin}><ProjectIcon mark="pinned" size={14} strong={selected} /></View>}
        <Text variant="caption" color={unread ? "unread" : "textSubtle"} numberOfLines={1} maxFontSizeMultiplier={16 / 13}
          style={[styles.time, unread && styles.strong]}>{stamp}</Text>
      </View>
      <View style={styles.details}>{children}</View>
    </>}
  </Pressable>;
}

const styles = StyleSheet.create({
  row: { minHeight: 52, justifyContent: "center", paddingHorizontal: spacing.lg, paddingVertical: 10, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22, fontWeight: "400" },
  strong: { fontWeight: "600" },
  pin: { width: 14, height: 14 },
  mark: { marginRight: -4 },
  details: { paddingLeft: 24, gap: 2 },
  time: { flexShrink: 1, maxWidth: "28%", fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
});
