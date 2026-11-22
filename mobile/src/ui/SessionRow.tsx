import { Children, memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, SessionSort } from "@shared/protocol";
import { stateOf, type SessionState } from "../logic/agents";
import { relativeTime } from "../logic/time";
import { MIN_TOUCH, spacing, useColors, withAlpha } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";
import { ProjectIcon } from "./ProjectIcon";
import { ProviderMark, sessionIdentity } from "./ProviderMark";
import { Text } from "./Text";

const STATE_LABEL: Record<SessionState, string | null> = { waiting: "Needs your reply", error: "Stopped with an error", running: "Working", unread: null, idle: null };
const STATE_COLOR: Record<SessionState, PaletteName> = { waiting: "warning", error: "danger", running: "accentText", unread: "textMuted", idle: "textMuted" };
type RowActions = { agent: Agent; selected?: boolean; onPress: (id: string) => void; onLongPress: (agent: Agent) => void };

export const SessionRow = memo(function SessionRow({ agent, selected, subtitle, time = "updated", onPress, onLongPress }: RowActions & { subtitle: string; time?: SessionSort }) {
  const state = stateOf(agent);
  const label = STATE_LABEL[state];
  const queued = agent.queue?.filter((message) => !message.sent).length ?? 0;
  const context = [queued ? `${queued} queued` : null, subtitle].filter(Boolean).join(" · ");
  return <SessionRowFrame agent={agent} selected={selected} state={state} stamp={relativeTime(time === "created" ? agent.createdAt : agent.updatedAt)}
    emphasized={!!agent.unread || state === "waiting"} detailsLabel={context} showPin onPress={onPress} onLongPress={onLongPress}>
    {(label || context) ? <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.6}>
      {label && <Text variant="caption" color={STATE_COLOR[state]} maxFontSizeMultiplier={1.6} style={styles.state}>{label}</Text>}
      {label && context ? " · " : ""}{context}
    </Text> : null}
  </SessionRowFrame>;
});

export function SessionRowFrame({ agent, selected, state, stamp, emphasized, showPin, detailsLabel, children, onPress, onLongPress }: RowActions & {
  state: SessionState; stamp: string; emphasized: boolean; showPin?: boolean; detailsLabel?: string; children: ReactNode;
}) {
  const colors = useColors();
  const hasDetails = Children.toArray(children).length > 0;
  return <Pressable accessibilityRole="button" accessibilityLabel={[agent.title, sessionIdentity(agent.harness, state), agent.pinned ? "Pinned" : null, agent.done ? "Done" : null, detailsLabel, stamp].filter(Boolean).join(", ")} accessibilityState={selected === undefined ? undefined : { selected }} accessibilityHint="Long press for more actions"
    onPress={() => onPress(agent.id)} onLongPress={() => onLongPress(agent)}
    style={({ pressed }) => [styles.row, !hasDetails && styles.centerRow, { backgroundColor: pressed ? colors.pressed : selected ? colors.selected : colors.surface, borderBottomColor: colors.separator }]}>
    {({ pressed }) => <>
      {state === "waiting" && !selected && !pressed && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.warning, 0.14) }]} />}
      <View style={styles.body}>
        <View style={styles.line}>
          <ProviderMark harness={agent.harness} state={state} selected={selected} />
          <Text color={showPin && agent.done ? "textMuted" : emphasized ? "textStrong" : "text"} numberOfLines={1} style={styles.title}>{agent.title}</Text>
          {showPin && agent.pinned && <View accessibilityLabel="Pinned" style={styles.pin}><ProjectIcon mark="pinned" size={14} strong={selected} /></View>}
          <Text variant="caption" color={showPin && agent.unread ? "unread" : "textMuted"} numberOfLines={1} maxFontSizeMultiplier={16 / 12}
            style={[styles.time, showPin && agent.unread && styles.state]}>{stamp}</Text>
        </View>
        {children}
      </View>
    </>}
  </Pressable>;
}

const styles = StyleSheet.create({
  row: { minHeight: 52, justifyContent: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  centerRow: { minHeight: MIN_TOUCH },
  body: { minWidth: 0 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  pin: { width: 14, height: 14 },
  time: { flexShrink: 1, maxWidth: "28%", fontVariant: ["tabular-nums"] },
  state: { fontWeight: "600" },
});
