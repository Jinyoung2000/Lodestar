import { useRouter } from "expo-router";
import { useEffect } from "react";
import { AccessibilityInfo, Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { client, useAppState, useConnection } from "../state/app";
import { MIN_TOUCH, spacing, useColors, withAlpha } from "../theme/theme";
import { Text } from "./Text";

export function useReconnect() {
  const router = useRouter();
  const { connection } = useConnection();
  const status = useAppState((s) => s.conn);
  return () => {
    if (status === "unauthorized" || !connection) router.replace("/connect");
    else if (status === "idle") client.configure(connection);
    else client.resume();
  };
}

export function ConnectionBanner() {
  const status = useAppState((s) => s.conn);
  const hostName = useAppState((s) => s.hostName);
  const reconnect = useReconnect();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const tone = status === "unauthorized" ? colors.danger : colors.warning;
  const message = status === "online" ? null : status === "unauthorized" ? `This phone was removed from ${hostName ?? "your Mac"}.`
    : status === "idle" ? "Not connected"
    : status === "connecting" ? "Connecting to your Mac…"
    : width < 340 ? "Offline. Retrying." : "Can't reach your Mac. Retrying.";
  useEffect(() => {
    if (message && Platform.OS === "ios") AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  }, [message]);
  if (!message) return null;

  const action = status === "unauthorized" ? "Pair again" : status === "idle" ? "Connect" : status === "connecting" ? null : "Retry";

  return (
    <View style={{ backgroundColor: colors.surface }}>
      <View style={[styles.strip, { backgroundColor: withAlpha(tone, 0.08), borderBottomColor: withAlpha(tone, 0.3) }]}>
        <View importantForAccessibility="no" style={[styles.dot, { backgroundColor: tone }]} />
        <Text accessibilityLiveRegion="polite" color="text" style={[styles.text, styles.message]} maxFontSizeMultiplier={0}>{message}</Text>
        {action && <Pressable accessibilityRole="button" onPress={reconnect} hitSlop={{ top: 8, bottom: 8 }} style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.pressed }]}>
          <Text color="accentText" style={[styles.text, styles.actionLabel]} maxFontSizeMultiplier={0}>{action}</Text>
        </Pressable>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderBottomWidth: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { fontSize: 13, lineHeight: 18 },
  message: { flex: 1, paddingVertical: spacing.xs },
  action: { minWidth: MIN_TOUCH, minHeight: 31, maxWidth: "45%", justifyContent: "center", paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  actionLabel: { fontWeight: "600", textAlign: "center" },
});
