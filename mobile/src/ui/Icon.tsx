import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useColors } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";

export function Icon({ name, size = 20, color = "text", weight = "regular" }: { name: SymbolViewProps["name"]; size?: number; color?: PaletteName; weight?: SymbolViewProps["weight"] }) {
  const colors = useColors();
  return <SymbolView name={name} size={size} tintColor={colors[color]} weight={weight} resizeMode="scaleAspectFit" style={{ width: size, height: size }} />;
}
