import { Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing, useColors } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

export const NEW_SESSION_CLEARANCE = 88;

export function NewSessionButton({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New session"
      onPress={onPress}
      style={({ pressed }) => [styles.fab, { bottom: insets.bottom + spacing.lg, backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1, shadowColor: colors.textStrong }]}
    >
      <Icon name="square.and.pencil" size={20} color="onAccent" />
      <Text variant="bodyStrong" color="onAccent" maxFontSizeMultiplier={1.3}>New</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: { position: "absolute", right: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 56, paddingVertical: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.xl - 4, borderRadius: 16, elevation: 3, shadowOpacity: 0.18, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
});
