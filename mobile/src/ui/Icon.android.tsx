import { SymbolView, type SymbolViewProps } from "expo-symbols";
import bold from "expo-symbols/androidWeights/bold";
import regular from "expo-symbols/androidWeights/regular";
import { useColors } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";
import { MATERIAL_ICONS } from "./iconNames";

export function Icon({ name, size = 20, color = "text", weight = "regular" }: { name: SymbolViewProps["name"]; size?: number; color?: PaletteName; weight?: SymbolViewProps["weight"] }) {
  const colors = useColors();
  const key = typeof name === "string" ? name : "";
  const symbol = MATERIAL_ICONS[key] ?? "help";
  const heavy = weight === "bold" || weight === "semibold" || weight === "heavy";
  return <SymbolView name={{ android: symbol }} size={size} tintColor={colors[color]} weight={{ ios: "regular", android: heavy ? bold : regular }} style={{ width: size, height: size }} />;
}
