import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";
import { Text } from "./Text";

export type SegmentedOption<T extends string> = { value: T; label: string; count?: number; countTone?: "neutral" | "attention" };

export function Segmented<T extends string>({ options, value, onChange, paneWidth, flush, underline }: { paneWidth?: number; options: SegmentedOption<T>[]; value: T; onChange: (value: T) => void; flush?: boolean; underline?: boolean }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const narrow = (paneWidth ?? width) < 380;
  return (
    <View accessibilityRole="tablist" style={[styles.wrap, narrow && styles.narrow, flush && styles.flush, underline && styles.tabBar, { backgroundColor: underline ? colors.background : colors.overlay, borderColor: colors.separator }]}>
      {options.map((option) => {
        const on = option.value === value;
        const counted = option.count !== undefined && option.count > 0;
        const attention = counted && option.countTone === "attention";
        const countColor: PaletteName = attention ? "background" : "textMuted";
        const label = <>
          <Text variant="secondary" color={on ? "textStrong" : "textMuted"} numberOfLines={1} maxFontSizeMultiplier={narrow ? 16 / 14 : 18 / 14} style={styles.label}>{option.label}</Text>
          {counted && <View style={attention ? [styles.badge, { backgroundColor: colors.warning }] : undefined}>
            <Text variant="caption" color={countColor} maxFontSizeMultiplier={attention ? 1 : 1.3} style={styles.count}>{option.count}</Text>
          </View>}
        </>;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={counted ? `${option.label}, ${option.count}` : option.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(option.value)}
            style={[styles.item, narrow && { columnGap: 4, paddingHorizontal: 2 }, underline ? styles.textTab : on && { backgroundColor: colors.selected }]}
          >
            {underline ? <View style={[styles.tabFace, narrow && styles.narrowFace]}>
              {label}
              {on && <View pointerEvents="none" style={[styles.indicator, { backgroundColor: colors.accentText }]} />}
            </View> : label}
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
  tabBar: { marginHorizontal: 0, marginTop: 0, marginBottom: 0, borderRadius: 0, borderWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, padding: 0, paddingHorizontal: spacing.sm },
  textTab: { minHeight: MIN_TOUCH, borderRadius: 0 },
  tabFace: { flex: 1, minWidth: 0, minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", columnGap: 6 },
  narrowFace: { columnGap: spacing.xs },
  indicator: { position: "absolute", height: 2, bottom: 0, left: spacing.sm, right: spacing.sm },
  item: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", flexDirection: "row", columnGap: 6, minHeight: 44, paddingHorizontal: spacing.xs, paddingVertical: spacing.xs, alignItems: "center", justifyContent: "center", borderRadius: radius.md - 2 },
  label: { fontWeight: "600", flexShrink: 1, textAlign: "center" },
  badge: { minWidth: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  count: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
