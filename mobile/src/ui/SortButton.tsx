import type { SessionSort } from "@shared/protocol";
import { useRef, useState, type ComponentRef } from "react";
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

type SortOption<T extends string> = { value: T; label: string };
type SortAction = { label: string; onPress: () => void };
type Anchor = { right: number; top: number; bottom: number };

const MENU_WIDTH = 184;
export const SESSION_SORT_OPTIONS: readonly SortOption<SessionSort>[] = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
];

export function SortButton<T extends string>({ label, value, options, onChange, action }: {
  label: string;
  value: T;
  options: readonly SortOption<T>[];
  onChange: (value: T) => void;
  action?: SortAction;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const button = useRef<ComponentRef<typeof Pressable>>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const active = options.find((option) => option.value === value);
  const close = () => setAnchor(null);
  const open = () => {
    Keyboard.dismiss();
    button.current?.measureInWindow((x, y, w, h) => {
      if (w && h) setAnchor({ right: x + w, top: y, bottom: y + h });
    });
  };
  const safeTop = insets.top + spacing.sm;
  const safeRight = width - insets.right - spacing.sm;
  const safeBottom = height - insets.bottom - spacing.sm;
  const safeLeft = insets.left + spacing.sm;
  const menuWidth = Math.min(MENU_WIDTH, safeRight - safeLeft);
  const menuHeight = Math.min((options.length + Number(!!action)) * MIN_TOUCH + spacing.sm, safeBottom - safeTop);

  return (
    <>
      <Pressable ref={button} collapsable={false} accessibilityRole="button" accessibilityLabel={label}
        accessibilityState={{ expanded: !!anchor }} accessibilityValue={{ text: active?.label }} onPress={open}
        style={({ pressed }) => [styles.button, pressed && { backgroundColor: colors.pressed }]}>
        <Icon name="arrow.up.arrow.down" size={18} color="textStrong" />
      </Pressable>
      {anchor && <Modal transparent animationType="fade" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal onAccessibilityEscape={close}>
          <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={close} />
          <View accessibilityRole="menu" style={[styles.menu, {
            width: menuWidth,
            maxHeight: menuHeight + 2,
            left: Math.max(safeLeft, Math.min(anchor.right, safeRight) - menuWidth),
            top: anchor.bottom + menuHeight + spacing.xs <= safeBottom
              ? Math.max(safeTop, anchor.bottom + spacing.xs)
              : Math.max(safeTop, Math.min(anchor.top - menuHeight - spacing.xs, safeBottom - menuHeight)),
            backgroundColor: colors.overlay,
            borderColor: colors.border,
          }]}>
            <ScrollView bounces={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.items}>
              {options.map((option) => (
                <MenuItem key={option.value} label={option.label} selected={option.value === value} onPress={() => {
                  close();
                  onChange(option.value);
                }} />
              ))}
              {action && <View style={[styles.separator, { borderTopColor: colors.separator }]}>
                <MenuItem label={action.label} onPress={() => { close(); action.onPress(); }} />
              </View>}
            </ScrollView>
          </View>
        </View>
      </Modal>}
    </>
  );
}

function MenuItem({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="menuitem" accessibilityState={{ selected }} onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.pressed }]}>
      <Text variant="secondary" color="textStrong" style={styles.itemLabel}>{label}</Text>
      {selected && <Icon name="checkmark" size={16} color="accentText" weight="semibold" />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  menu: { position: "absolute", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", elevation: 6 },
  items: { paddingVertical: spacing.xs },
  item: { minHeight: MIN_TOUCH, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, gap: spacing.sm },
  itemLabel: { flex: 1 },
  separator: { borderTopWidth: StyleSheet.hairlineWidth },
});
