import type { SymbolViewProps } from "expo-symbols";
import { ActivityIndicator, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { MIN_TOUCH, radius, spacing, useColors, useScheme } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

type Props = { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger" | "plain"; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>; flex?: boolean; icon?: SymbolViewProps["name"] };

export function Button({ title, onPress, kind = "secondary", disabled, busy, style, flex, icon }: Props) {
  const colors = useColors();
  const scheme = useScheme();
  const outlinedDanger = kind === "danger" && scheme === "dark";
  const bg = kind === "primary" ? colors.accent : outlinedDanger ? colors.surface : kind === "danger" ? colors.danger : kind === "plain" ? "transparent" : colors.overlay;
  const foreground = outlinedDanger ? "danger" : kind === "primary" || kind === "danger" ? "onAccent" : kind === "plain" ? "accentText" : "textStrong";
  const fg = colors[foreground];
  const borderColor = outlinedDanger ? colors.danger : kind === "secondary" ? colors.border : "transparent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.base, icon && styles.icon, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1, borderColor, borderWidth: outlinedDanger ? 1 : StyleSheet.hairlineWidth, flex: flex ? 1 : undefined }, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={22} color={foreground} /> : <Text variant="bodyStrong" maxFontSizeMultiplier={1.3} style={{ color: fg, textAlign: "center", flexShrink: 1 }}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: Math.max(48, MIN_TOUCH), paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, borderRadius: radius.md, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  icon: { width: 48, borderRadius: radius.pill, paddingHorizontal: 0 },
});
