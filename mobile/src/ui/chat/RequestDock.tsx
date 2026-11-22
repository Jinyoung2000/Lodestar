import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { RequestDraft } from "../../state/sessionView";
import { MIN_TOUCH, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

export type DockLayout = { draft: RequestDraft; limit: number; compact: boolean; short: boolean; offline: boolean; focusOnOpen: boolean; onOpen: () => void };

type Props = DockLayout & { label: string; summary: string; questionTitle?: string; progressLabel?: string; warning?: boolean; step?: number; busy?: boolean; footer?: ReactNode; children: ReactNode };

export function RequestDock({ draft, limit, compact, short, focusOnOpen, onOpen, label, summary, questionTitle, progressLabel, warning, step, busy, footer, children }: Props) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(focusOnOpen || draft.expanded);
  const focused = useRef(false);
  const heading = useRef<ComponentRef<typeof View>>(null);
  const inlineHeading = expanded && !!questionTitle && !short;
  const expandedLabel = questionTitle ? (progressLabel ?? "") + questionTitle : label;
  const focusHeading = () => {
    if (focused.current) return;
    focused.current = true;
    Keyboard.dismiss();
    onOpen();
    if (focusOnOpen && heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, "focus");
  };
  const toggle = () => {
    Keyboard.dismiss();
    draft.expanded = !expanded;
    setExpanded(draft.expanded);
  };
  const headingButton = (
    <Pressable ref={heading} accessibilityRole="button" accessibilityLabel={expanded ? expandedLabel : summary}
      accessibilityState={{ expanded, disabled: !!busy }} disabled={busy} onLayout={focusHeading} onPress={toggle}
      hitSlop={short ? { top: 4, bottom: 4 } : undefined} style={[styles.head, inlineHeading && styles.inlineHead, short && styles.shortHead]}>
      {expanded && questionTitle ? (
        <Text color="textStrong" numberOfLines={short ? 2 : undefined} maxFontSizeMultiplier={1.3} style={[styles.label, styles.questionTitle]}>
          {!!progressLabel && <Text style={styles.questionTitle} color="textMuted" maxFontSizeMultiplier={1.3}>{progressLabel}</Text>}{questionTitle}
        </Text>
      ) : (
        <Text variant={expanded ? "caption" : "bodyStrong"} color={expanded ? (warning ? "warning" : "accentText") : "textStrong"}
          numberOfLines={1} maxFontSizeMultiplier={expanded ? 16 / 12 : 20 / 16} style={styles.label}>{expanded ? label : summary}</Text>
      )}
      <Icon name={expanded ? "chevron.down" : "chevron.up"} size={20} color="textMuted" />
    </Pressable>
  );
  return (
    <View style={[styles.dock, { maxHeight: limit, height: expanded && short ? limit : undefined, backgroundColor: colors.surface, borderColor: colors.border }]}>
      {!inlineHeading && headingButton}
      {expanded && <>
        <ScrollView key={step} style={[styles.body, short && { flexGrow: 1 }]} contentContainerStyle={[styles.bodyContent, short && { paddingBottom: spacing.sm }]} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {inlineHeading && headingButton}
          {children}
        </ScrollView>
        {footer && <View style={[styles.footer, compact && { paddingBottom: spacing.sm }, short && { paddingTop: 6, paddingBottom: 6 }, { borderTopColor: colors.separator }]}>{footer}</View>}
      </>}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { flexShrink: 1, overflow: "hidden", borderTopWidth: 1, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  head: { minHeight: MIN_TOUCH, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg },
  inlineHead: { paddingHorizontal: 0, paddingVertical: spacing.xs },
  shortHead: { minHeight: 40, paddingVertical: 6 },
  questionTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  label: { flex: 1, fontWeight: "600" },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs, gap: 2 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: spacing.sm },
});
