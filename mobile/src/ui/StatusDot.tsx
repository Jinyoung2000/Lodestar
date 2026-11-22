import { ActivityIndicator, View } from "react-native";
import type { SessionState } from "../logic/agents";
import { useColors } from "../theme/theme";

export function StatusDot({ state, size = 12 }: { state: SessionState; size?: number }) {
  const colors = useColors();
  if (state === "running" && size > 8) return <ActivityIndicator size="small" color={colors.running} style={{ width: size + 4, height: size + 4 }} />;
  const color = state === "running" ? colors.running : state === "waiting" ? colors.warning : state === "error" ? colors.danger : state === "unread" ? colors.unread : null;
  return <View style={{ width: size + 4, height: size + 4, alignItems: "center", justifyContent: "center" }}>{color && <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />}</View>;
}
