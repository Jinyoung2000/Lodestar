import { createContext, useContext } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";
import type { ThemeChoice } from "../state/themePrefs";
import { palette, type PaletteName } from "./tokens.generated";

export type Colors = Record<PaletteName, string>;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
export const scrim = "rgba(0,0,0,0.5)";

export const type = {
  largeTitle: { fontSize: 28, lineHeight: 34, fontWeight: "700" as const },
  title: { fontSize: 17, lineHeight: 24, fontWeight: "600" as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: "600" as const },
  secondary: { fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" as const },
  mono: { fontSize: 13, lineHeight: 20, fontWeight: "400" as const, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
} as const;
export type TypeName = keyof typeof type;

export const MIN_TOUCH = Platform.OS === "android" ? 48 : 44;

const themes = {
  light: { scheme: "light", colors: palette.light },
  dark: { scheme: "dark", colors: palette.dark },
  midnight: {
    scheme: "dark",
    colors: {
      ...palette.dark,
      background: "#08090b",
      surfaceBase: "#0c0d10",
      surface: "#111216",
      overlay: "#191a20",
      pressed: "#202127",
      selected: "#292b34",
      separator: "#22242a",
      border: "#373942",
      inputBackground: "#1a1b20",
      inputBorder: "#363840",
      codeBackground: "#101115",
      userBubble: "#172331",
    },
  },
} as const;
export type Scheme = (typeof themes)[keyof typeof themes]["scheme"];
const ThemeContext = createContext<{ scheme: Scheme; colors: Colors }>(themes.dark);
export const ThemeProvider = ThemeContext.Provider;

export function useColors(): Colors {
  return useContext(ThemeContext).colors;
}

export function useScheme(): Scheme {
  return useContext(ThemeContext).scheme;
}

export function useSchemeColors(choice: ThemeChoice | null): { colors: Colors; scheme: Scheme } {
  const systemScheme = useColorScheme() ?? Appearance.getColorScheme();
  const scheme = choice && choice !== "system" ? choice : systemScheme === "dark" ? "dark" : "light";
  return themes[scheme];
}

export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value.slice(0, 6);
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `#${full}${a}`;
}
