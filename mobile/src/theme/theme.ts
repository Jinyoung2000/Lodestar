import { createContext, useContext } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";
import { palette, type PaletteName } from "./tokens.generated";

export type Colors = Record<PaletteName, string>;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

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

export const MIN_TOUCH = 44;

const ThemeContext = createContext<Colors>(palette.dark);
export const ThemeProvider = ThemeContext.Provider;

export function useColors(): Colors {
  return useContext(ThemeContext);
}

export function useSchemeColors(): { colors: Colors; scheme: "dark" | "light" } {
  const scheme = (useColorScheme() ?? Appearance.getColorScheme()) === "dark" ? "dark" : "light";
  return { colors: palette[scheme], scheme };
}

export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value.slice(0, 6);
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `#${full}${a}`;
}
