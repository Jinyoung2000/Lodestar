import { SymbolView, type SymbolViewProps } from "expo-symbols";
import bold from "expo-symbols/androidWeights/bold";
import regular from "expo-symbols/androidWeights/regular";
import { useColors } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";
import { MATERIAL_ICONS } from "./iconNames";

// 안드로이드에는 SF Symbols 가 없다. 호출하는 쪽은 iOS 와 같은 SF 이름을 넘기고(Icon.tsx 와 같은 인터페이스), 여기서 Material Symbols 이름으로 바꿔 그린다.
// 새 아이콘을 쓰면 이 표에 한 줄을 더한다. 빠진 이름은 개발 중에 바로 드러나도록 빈칸으로 두지 않고 물음표를 그린다.
export function Icon({ name, size = 20, color = "text", weight = "regular" }: { name: SymbolViewProps["name"]; size?: number; color?: PaletteName; weight?: SymbolViewProps["weight"] }) {
  const colors = useColors();
  const key = typeof name === "string" ? name : "";
  const symbol = MATERIAL_ICONS[key] ?? "help";
  const heavy = weight === "bold" || weight === "semibold" || weight === "heavy";
  return <SymbolView name={{ android: symbol }} size={size} tintColor={colors[color]} weight={{ ios: "regular", android: heavy ? bold : regular }} style={{ width: size, height: size }} />;
}
