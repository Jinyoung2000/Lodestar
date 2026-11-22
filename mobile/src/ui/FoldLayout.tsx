import { requireOptionalNativeModule } from "expo";
import { createContext, useContext, useSyncExternalStore } from "react";
import { Dimensions, PixelRatio } from "react-native";

const settings = requireOptionalNativeModule<{
  fontScale(): number;
  addListener(event: "fontScaleChanged", notify: () => void): { remove(): void };
}>("LodestarWindowSettings");

function subscribeFontScale(notify: () => void) {
  const listener = settings
    ? settings.addListener("fontScaleChanged", notify)
    : Dimensions.addEventListener("change", notify);
  return () => listener.remove();
}

function readFontScale() {
  return settings?.fontScale() ?? PixelRatio.getFontScale();
}

export function useWindowFontScale() {
  return useSyncExternalStore(subscribeFontScale, readFontScale);
}

export function foldRailWidth(width: number, fontScale: number) {
  const largeText = fontScale >= 1.3;
  if (width < (largeText ? 640 : 600)) return 0;
  if (width >= 840) return 360;
  return width >= 720 || largeText ? 320 : 280;
}

export const FoldLayoutContext = createContext({ connectionInRail: false, wide: false, expanded: false, railWidth: 0, paneWidth: 0, fontScale: 1 });

export function useFoldLayout() {
  return useContext(FoldLayoutContext);
}
