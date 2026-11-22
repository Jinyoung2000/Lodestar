import type { SymbolViewProps } from "expo-symbols";
import { Text } from "react-native";
import { useColors } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";
import { MATERIAL_ICONS } from "./iconNames";

export function Icon({ name, size = 20, color = "text" }: { name: SymbolViewProps["name"]; size?: number; color?: PaletteName; weight?: SymbolViewProps["weight"] }) {
  const colors = useColors();
  const icon = typeof name === "string" ? MATERIAL_ICONS[name] : undefined;
  if (!icon) return null;
  return <Text accessible={false} importantForAccessibility="no" allowFontScaling={false} style={{ fontFamily: "LodestarSymbols", color: colors[color], fontSize: size, lineHeight: size, includeFontPadding: false, textAlign: "center" }}>{String.fromCodePoint(icon[1])}</Text>;
}
