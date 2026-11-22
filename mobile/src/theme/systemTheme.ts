import { requireOptionalNativeModule } from "expo";
import { processColor } from "react-native";
import type { Scheme } from "./theme";

const systemUI = requireOptionalNativeModule<{
  setBackgroundColorAsync?(color: number): Promise<void>;
}>("ExpoSystemUI");
const windowSettings = requireOptionalNativeModule<{
  setNavigationBarStyle?(lightBackground: boolean): Promise<void>;
}>("LodestarWindowSettings");

export async function applySystemTheme(background: string, scheme: Scheme) {
  const color = processColor(background);
  try {
    await Promise.all([
      typeof color === "number" && systemUI?.setBackgroundColorAsync?.(color),
      windowSettings?.setNavigationBarStyle?.(scheme === "light"),
    ]);
  } catch (error) {
    console.warn("Could not update system appearance", error);
  }
}
