import { Pressable, StyleSheet, View } from "react-native";
import { openDecisionCount } from "../../logic/mateCore.generated";
import { mateStatus } from "../../logic/mate";
import { useAppState } from "../../state/app";
import { MIN_TOUCH, radius, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

type MateRowProps = { selected?: boolean; onPress: () => void };

export function MateRow({ selected, onPress }: MateRowProps) {
  const colors = useColors();
  const assistant = useAppState((s) => s.assistant);
  const agents = useAppState((s) => s.agents);
  const items = useAppState((s) => s.followUps?.items);
  const agent = agents.find((a) => a.id === assistant?.agentId);
  if (!assistant?.enabled || !agent) return null;
  const now = Date.now();
  const waiting = items ? openDecisionCount(agents, items, now) : 0;
  const status = mateStatus(agent, assistant, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[agent.title, status, waiting > 0 ? `${waiting} waiting on you` : agent.unread ? "New message" : null].filter(Boolean).join(", ")}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : selected ? colors.selected : colors.background, borderBottomColor: colors.separator }]}
    >
      <MateAvatar size={36} />
      <View style={styles.text}>
        <Text variant="bodyStrong" color="textStrong" numberOfLines={1}>
          {agent.title}
        </Text>
        <Text variant="secondary" color="textMuted" numberOfLines={1}>
          {status}
        </Text>
      </View>
      {waiting > 0 ? (
        <View style={[styles.badge, { backgroundColor: colors.accent }]}>
          <Text variant="caption" color="onAccent" maxFontSizeMultiplier={1} style={styles.count}>
            {waiting}
          </Text>
        </View>
      ) : (
        agent.unread && <View style={[styles.dot, { backgroundColor: colors.unread }]} />
      )}
    </Pressable>
  );
}

type MateAvatarProps = { size: number };

function MateAvatar({ size }: MateAvatarProps) {
  const colors = useColors();
  return (
    <View style={[styles.avatar, { width: size, height: size, borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Icon name="safari" size={Math.round(size * 0.56)} color="textStrong" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: MIN_TOUCH + spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  text: { flex: 1, minWidth: 0 },
  avatar: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: radius.pill },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  count: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  dot: { width: 8, height: 8, borderRadius: radius.pill, marginRight: 7 },
});
