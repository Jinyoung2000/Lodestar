import type { ComponentProps } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { radius, spacing, useColors } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

export type ToolbarButtonProps = { icon: ComponentProps<typeof Icon>["name"]; label: string; count?: number; badge?: number; onPress?: () => void };

export function ToolbarButton({ icon, label, count, badge, onPress }: ToolbarButtonProps) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !onPress }} disabled={!onPress} onPress={onPress}
    style={({ pressed }) => [styles.button, count !== undefined && styles.countButton, pressed && { backgroundColor: colors.pressed }]}>
    <Icon name={icon} size={20} color={onPress ? "textStrong" : "textSubtle"} />
    {count !== undefined && <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.count}>{count}</Text>}
    {badge !== undefined && <View style={[styles.badge, { backgroundColor: colors.warning }]}>
      <Text variant="caption" color="background" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.badgeText}>{badge}</Text>
    </View>}
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { width: 48, height: 48, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  countButton: { width: "auto", minWidth: 48, flexDirection: "row", gap: spacing.xs, paddingHorizontal: spacing.sm },
  count: { fontVariant: ["tabular-nums"] },
  badge: { position: "absolute", top: 5, right: 1, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 12, lineHeight: 18, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
