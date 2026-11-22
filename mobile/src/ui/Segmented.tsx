import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { radius, spacing, useColors } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";
import { Text } from "./Text";

export type SegmentedOption<T extends string> = { value: T; label: string; count?: number; countTone?: "neutral" | "attention" };

export function Segmented<T extends string>({ options, value, onChange, paneWidth, flush }: { paneWidth?: number; options: SegmentedOption<T>[]; value: T; onChange: (value: T) => void; flush?: boolean }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const narrow = (paneWidth ?? width) < 380;
  return (
    <View accessibilityRole="tablist" style={[styles.wrap, narrow && styles.narrow, flush && styles.flush, { backgroundColor: colors.overlay, borderColor: colors.separator }]}>
      {options.map((option) => {
        const on = option.value === value;
        const counted = option.count !== undefined && option.count > 0;
        const attention = counted && option.countTone === "attention";
        const countColor: PaletteName = attention ? "background" : "textMuted";
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={counted ? `${option.label}, ${option.count}` : option.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(option.value)}
            style={[styles.item, narrow && { columnGap: 4, paddingHorizontal: 2 }, on && { backgroundColor: colors.selected }]}
          >
            <Text variant="secondary" color={on ? "textStrong" : "textMuted"} numberOfLines={1} maxFontSizeMultiplier={narrow ? 16 / 14 : 18 / 14} style={styles.label}>{option.label}</Text>
            {counted && <View style={attention ? [styles.badge, { backgroundColor: colors.warning }] : undefined}>
              <Text variant="caption" color={countColor} maxFontSizeMultiplier={attention ? 1 : 1.3} style={styles.count}>{option.count}</Text>
            </View>}
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
  badge: { minWidth: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  count: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
