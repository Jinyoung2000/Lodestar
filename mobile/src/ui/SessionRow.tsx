import * as Haptics from "expo-haptics";
import { memo, useMemo, useRef, type ReactNode } from "react";
import { Alert, Animated, PanResponder, Pressable, StyleSheet, View } from "react-native";
import type { Agent, SessionSort } from "@shared/protocol";
import { stateOf, type SessionState } from "../logic/agents";
import { relativeTime } from "../logic/time";
import { store } from "../state/app";
import { spacing, useColors, withAlpha } from "../theme/theme";
import { Icon } from "./Icon";
import { endSplitPress } from "./SplitDrag";
import { ProjectIcon } from "./ProjectIcon";
import { ProviderLabel, ProviderMark, sessionIdentity, useProviderName } from "./ProviderMark";
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

const SWIPE_COMMIT = 88;
export const ROW_INSET = 22;

function SessionRowFrame({ agent, selected, state, stamp, emphasized, showPin, detailsLabel, children, onPress, onLongPress }: RowActions & {
  state: SessionState; stamp: string; emphasized: boolean; showPin?: boolean; detailsLabel?: string; children: ReactNode;
}) {
  const colors = useColors();
  const providerName = useProviderName(agent.providerId);
  const unread = showPin && !!agent.unread;
  const doneLabel = agent.done ? "Mark as not done" : "Mark as done";
  const actionColor = agent.done ? "textStrong" : "onAccent";
  const toggleDone = () => void store.setDone(agent.id, !agent.done).catch((error: unknown) => Alert.alert("Could not update the session", error instanceof Error ? error.message : String(error)));
  const swipe = useRowSwipe(toggleDone);
  return <View style={{ backgroundColor: agent.done ? colors.overlay : colors.success }}>
    <Animated.View pointerEvents="none" style={[styles.action, { opacity: swipe.reveal }]}>
      <Icon name={agent.done ? "circle" : "checkmark"} size={18} color={actionColor} />
      <Text variant="secondary" color={actionColor} style={styles.strong}>{agent.done ? "Not done" : "Done"}</Text>
    </Animated.View>
    <Animated.View {...swipe.handlers} style={{ transform: [{ translateX: swipe.offset }], backgroundColor: colors.background }}>
      <Pressable accessibilityRole="button" accessibilityLabel={[agent.title, sessionIdentity(agent.harness, state, providerName), agent.pinned ? "Pinned" : null, agent.done ? "Done" : null, detailsLabel, stamp].filter(Boolean).join(", ")} accessibilityState={selected === undefined ? undefined : { selected }} accessibilityHint="Long press for more actions"
        accessibilityActions={[{ name: "toggleDone", label: doneLabel }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "toggleDone") toggleDone(); }}
        onPress={() => onPress(agent.id)} onLongPress={() => onLongPress(agent)} onPressOut={endSplitPress}
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : selected ? colors.selected : colors.background }]}>
        {({ pressed }) => <>
          {state === "waiting" && !selected && !pressed && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.warning, 0.14) }]} />}
          {unread && <View pointerEvents="none" style={[styles.unreadDot, { backgroundColor: colors.unread }]} />}
          <View style={styles.line}>
            <View style={styles.mark}><ProviderMark harness={agent.harness} providerId={agent.providerId} size={16} /></View>
            <Text color={showPin && agent.done ? "textMuted" : emphasized ? "textStrong" : "text"} numberOfLines={1} style={[styles.title, emphasized && styles.strong]}>{agent.title}</Text>
            {showPin && agent.pinned && <View accessibilityLabel="Pinned" style={styles.pin}><ProjectIcon mark="pinned" size={14} strong={selected} /></View>}
            <Text variant="caption" color={unread ? "unread" : "textSubtle"} numberOfLines={1} maxFontSizeMultiplier={16 / 13}
              style={[styles.time, unread && styles.strong]}>{stamp}</Text>
          </View>
          <View style={styles.details}>{children}</View>
        </>}
      </Pressable>
    </Animated.View>
  </View>;
}

function useRowSwipe(onCommit: () => void) {
  const commit = useRef(onCommit);
  commit.current = onCommit;
  return useMemo(() => {
    const offset = new Animated.Value(0);
    const reveal = offset.interpolate({ inputRange: [-SWIPE_COMMIT, -24, 0], outputRange: [1, 0.35, 0], extrapolate: "clamp" });
    let armed = false;
    const settle = () => Animated.spring(offset, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
    const handlers = PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dx, dy }) => dx < -12 && Math.abs(dx) > 2 * Math.abs(dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { armed = false; },
      onPanResponderMove: (_, { dx }) => {
        const next = Math.min(0, dx);
        offset.setValue(next);
        if ((next <= -SWIPE_COMMIT) === armed) return;
        armed = next <= -SWIPE_COMMIT;
        if (armed) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      },
      onPanResponderRelease: (_, { dx, vx }) => {
        if (dx <= -SWIPE_COMMIT || (dx < -40 && vx < -0.8)) commit.current();
        settle();
      },
      onPanResponderTerminate: settle,
    }).panHandlers;
    return { offset, reveal, handlers };
  }, []);
}

const styles = StyleSheet.create({
  row: { minHeight: 48, justifyContent: "center", paddingLeft: ROW_INSET, paddingRight: spacing.lg, paddingVertical: spacing.sm, gap: 1 },
  action: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6, paddingRight: spacing.xl },
  line: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: "400" },
  strong: { fontWeight: "600" },
  pin: { width: 14, height: 14 },
  mark: { marginRight: -4 },
  unreadDot: { position: "absolute", left: ROW_INSET - 14, top: spacing.sm + 6, width: 8, height: 8, borderRadius: 4 },
  details: { paddingLeft: 22, gap: 1 },
  time: { flexShrink: 1, maxWidth: "28%", fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
});
