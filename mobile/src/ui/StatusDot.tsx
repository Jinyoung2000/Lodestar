import { ActivityIndicator, View } from "react-native";
import type { SessionState } from "../logic/agents";
import { useColors, withAlpha } from "../theme/theme";

export function StatusDot({ state, size = 12 }: { state: SessionState; size?: number }) {
  const colors = useColors();
  const box = size === 8 ? 16 : size + 6;
  if (state === "running" && size > 8) return <ActivityIndicator size={size} color={colors.running} style={{ width: size, height: size }} />;
  const color = state === "running" ? colors.running : state === "waiting" ? colors.warning : state === "error" ? colors.danger : state === "unread" ? colors.unread : null;
  const core = state === "unread" ? (size === 8 ? 8 : Math.max(6, size - 4)) : size;
  const halo = state === "waiting" || state === "error";
  return (
    <View importantForAccessibility="no-hide-descendants" style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }}>
      {color && halo && <View style={{ position: "absolute", width: box, height: box, borderRadius: box / 2, backgroundColor: withAlpha(color, 0.22) }} />}
      {color && <View style={{ width: core, height: core, borderRadius: core / 2, backgroundColor: color }} />}
    </View>
  );
}
