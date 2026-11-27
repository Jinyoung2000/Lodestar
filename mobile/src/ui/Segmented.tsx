import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { radius, spacing, useColors } from "../theme/theme";
import { Text } from "./Text";

export type SegmentedOption<T extends string> = { value: T; label: string };

export function Segmented<T extends string>({ options, value, onChange, paneWidth, flush }: { paneWidth?: number; options: SegmentedOption<T>[]; value: T; onChange: (value: T) => void; flush?: boolean }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const narrow = (paneWidth ?? width) < 380;
  return (
    <View accessibilityRole="tablist" style={[styles.wrap, narrow && styles.narrow, flush && styles.flush, { backgroundColor: colors.overlay, borderColor: colors.separator }]}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(option.value)}
            style={[styles.item, narrow && { columnGap: 4, paddingHorizontal: 2 }, on && { backgroundColor: colors.selected }]}
          >
            <Text variant="secondary" color={on ? "textStrong" : "textMuted"} numberOfLines={1} maxFontSizeMultiplier={narrow ? 16 / 14 : 18 / 14} style={styles.label}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", marginHorizontal: spacing.lg, marginTop: spacing.xs, marginBottom: spacing.xs, padding: 2, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  narrow: { marginHorizontal: spacing.md },
  flush: { margin: 0, marginHorizontal: 0, marginTop: 0, marginBottom: 0 },
  item: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", flexDirection: "row", columnGap: 6, minHeight: 44, paddingHorizontal: spacing.xs, paddingVertical: spacing.xs, alignItems: "center", justifyContent: "center", borderRadius: radius.md - 2 },
  label: { fontWeight: "600", flexShrink: 1, textAlign: "center" },
});
