import { ActivityIndicator, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Text } from "./Text";

type Props = { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger" | "plain"; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>; flex?: boolean };

export function Button({ title, onPress, kind = "secondary", disabled, busy, style, flex }: Props) {
  const colors = useColors();
  const bg = kind === "primary" ? colors.accent : kind === "danger" ? colors.danger : kind === "plain" ? "transparent" : colors.overlay;
  const fg = kind === "primary" || kind === "danger" ? colors.onAccent : kind === "plain" ? colors.accentText : colors.textStrong;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.base, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1, borderColor: kind === "secondary" ? colors.border : "transparent", flex: flex ? 1 : undefined }, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text variant="bodyStrong" style={{ color: fg }} numberOfLines={1}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: MIN_TOUCH + 4, paddingHorizontal: spacing.lg, borderRadius: radius.md, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
});
