import { StyleSheet, View } from "react-native";
import { radius, withAlpha } from "../theme/theme";
import { Text } from "./Text";

const HUES = ["#4C8DF6", "#8E6CF0", "#E0668C", "#E0883A", "#3DA877", "#2FA3B8"];

export function projectHue(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return HUES[Math.abs(hash) % HUES.length];
}

export function ProjectIcon({ name, size = 36 }: { name: string; size?: number }) {
  const hue = projectHue(name);
  return (
    <View style={[styles.box, { width: size, height: size, backgroundColor: withAlpha(hue, 0.18), borderColor: withAlpha(hue, 0.4) }]}>
      <Text variant="bodyStrong" style={{ color: hue, fontSize: size * 0.45, lineHeight: size * 0.6 }}>{name.trim().charAt(0).toUpperCase() || "?"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({ box: { alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth } });
