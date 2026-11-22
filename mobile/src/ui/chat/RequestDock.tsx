import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { RequestDraft } from "../../state/sessionView";
import { MIN_TOUCH, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

export type DockLayout = { draft: RequestDraft; limit: number; compact: boolean; short: boolean; offline: boolean; focusOnOpen: boolean; onOpen: () => void };

type Props = DockLayout & { label: string; summary: string; shortTitle?: string; shortPrefix?: string; warning?: boolean; step?: number; busy?: boolean; footer?: ReactNode; children: ReactNode };

export function RequestDock({ draft, limit, compact, short, focusOnOpen, onOpen, label, summary, shortTitle, shortPrefix, warning, step, busy, footer, children }: Props) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(focusOnOpen || draft.expanded);
  const focused = useRef(false);
  const heading = useRef<ComponentRef<typeof View>>(null);
  return (
    <View style={[styles.dock, { maxHeight: limit, height: expanded && short ? limit : undefined, backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable ref={heading} accessibilityRole="button" accessibilityLabel={expanded ? (short && shortTitle ? (shortPrefix ?? "") + shortTitle : label) : summary} accessibilityState={{ expanded, disabled: !!busy }} disabled={busy}
        onLayout={() => {
          if (focused.current) return;
          focused.current = true;
          Keyboard.dismiss();
          onOpen();
          if (focusOnOpen && heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, "focus");
        }}
        onPress={() => { Keyboard.dismiss(); draft.expanded = !expanded; setExpanded(draft.expanded); }} hitSlop={short ? { top: 4, bottom: 4 } : undefined} style={[styles.head, short && styles.shortHead]}>
        {short && expanded && shortTitle ? <Text color="textStrong" numberOfLines={2} maxFontSizeMultiplier={1.2} style={[styles.label, styles.shortTitle]}>
          {!!shortPrefix && <Text style={styles.shortTitle} color="textMuted" maxFontSizeMultiplier={1.2}>{shortPrefix}</Text>}{shortTitle}
        </Text> : <Text variant={expanded ? "caption" : "bodyStrong"} color={expanded ? (warning ? "warning" : "accentText") : "textStrong"} numberOfLines={1} maxFontSizeMultiplier={expanded ? 16 / 12 : 20 / 16} style={styles.label}>{expanded ? label : summary}</Text>}
        <Icon name={expanded ? "chevron.down" : "chevron.up"} size={20} color="textMuted" />
      </Pressable>
      {expanded && <>
        <ScrollView key={step} style={[styles.body, short && { flexGrow: 1 }]} contentContainerStyle={[styles.bodyContent, short && { paddingBottom: spacing.sm }]} keyboardShouldPersistTaps="handled" nestedScrollEnabled>{children}</ScrollView>
        {footer && <View style={[styles.footer, compact && { paddingBottom: spacing.sm }, short && { paddingTop: 6, paddingBottom: 6 }, { borderTopColor: colors.separator }]}>{footer}</View>}
      </>}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { flexShrink: 1, elevation: 8, overflow: "hidden", borderTopWidth: 1, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  head: { minHeight: MIN_TOUCH, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg },
  shortHead: { minHeight: 40, paddingVertical: 6 },
  shortTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  label: { flex: 1, fontWeight: "600" },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: spacing.sm },
});
