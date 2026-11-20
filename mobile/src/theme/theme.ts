import { createContext, useContext } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";
import { palette, type PaletteName } from "./tokens.generated";

// 색은 Lodestar 의 디자인 토큰(tokens.generated.ts)에서 오고, 시스템 라이트와 다크를 따른다.
export type Colors = Record<PaletteName, string>;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

// 글자: 시스템 글꼴(iOS 는 SF, 안드로이드는 Roboto)과 기기의 글자 크기 설정(Dynamic Type)을 따른다. 본문은 16pt 이상, 줄 간격은 1.45 배.
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

// 최소 터치 영역(Apple HIG 44pt)
export const MIN_TOUCH = 44;

const ThemeContext = createContext<Colors>(palette.dark);
export const ThemeProvider = ThemeContext.Provider;

export function useColors(): Colors {
  return useContext(ThemeContext);
}

export function useSchemeColors(): { colors: Colors; scheme: "dark" | "light" } {
  // 앱이 막 떴을 때 훅이 null 을 줄 수 있어 기기의 현재 값을 먼저 읽는다(안 그러면 한 프레임 동안 다크 색이 헤더에 굳는다)
  const scheme = (useColorScheme() ?? Appearance.getColorScheme()) === "dark" ? "dark" : "light";
  return { colors: palette[scheme], scheme };
}

// 진행 중 표시처럼 색을 반투명으로 쓸 때
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value.slice(0, 6);
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `#${full}${a}`;
}
