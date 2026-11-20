import { Pressable, StyleSheet, View } from "react-native";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Text } from "./Text";

// 두세 개 중 하나를 고르는 줄(세션/워크스페이스 전환). 선택된 쪽이 떠 보인다.
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  const colors = useColors();
  return (
    <View accessibilityRole="tablist" style={[styles.wrap, { backgroundColor: colors.overlay }]}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(option.value)} style={[styles.item, on && { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text variant="secondary" color={on ? "textStrong" : "textMuted"} style={{ fontWeight: "600" }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", marginHorizontal: spacing.lg, marginTop: spacing.sm, marginBottom: spacing.xs, padding: 3, borderRadius: radius.md },
  item: { flex: 1, minHeight: MIN_TOUCH - 8, alignItems: "center", justifyContent: "center", borderRadius: radius.md - 2, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent" },
});
