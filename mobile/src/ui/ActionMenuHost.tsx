import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { registerActionMenuHost, type ActionMenuRequest } from "./actionMenu";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Text } from "./Text";

export function ActionMenuHost() {
  const colors = useColors();
  const [request, setRequest] = useState<ActionMenuRequest | null>(null);
  useEffect(() => {
    registerActionMenuHost(setRequest);
    return () => registerActionMenuHost(null);
  }, []);
  const close = () => setRequest(null);
  return (
    <Modal visible={request !== null} transparent animationType="fade" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
      <Pressable accessibilityLabel="Dismiss" style={styles.scrim} onPress={close}>
        <Pressable accessible={false} style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text variant="secondary" color="textMuted" numberOfLines={2} style={styles.title}>{request?.title}</Text>
          {request?.choices.map((choice) => (
            <Pressable
              key={choice.label}
              accessibilityRole="button"
              onPress={() => {
                close();
                choice.onPress();
              }}
              style={({ pressed }) => [styles.item, { borderTopColor: colors.separator, backgroundColor: pressed ? colors.pressed : "transparent" }]}
            >
              <Text variant="body" color="textStrong">{choice.label}</Text>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" onPress={close} style={({ pressed }) => [styles.item, { borderTopColor: colors.separator, backgroundColor: pressed ? colors.pressed : "transparent" }]}>
            <Text variant="bodyStrong" color="accentText">Cancel</Text>
          </Pressable>
          <View style={{ height: spacing.lg }} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  title: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  item: { minHeight: MIN_TOUCH + 8, justifyContent: "center", paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
});
