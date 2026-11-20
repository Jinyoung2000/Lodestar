import { memo } from "react";
import { Platform, Text as RNText, type TextProps as RNTextProps } from "react-native";
import { type PaletteName } from "../theme/tokens.generated";
import { type, useColors, type TypeName } from "../theme/theme";

// 안드로이드는 글꼴 위아래에 여분(font padding)을 더해서 줄 높이를 고정해도 글자가 위로 쏠려 보인다
const androidMetrics = Platform.OS === "android" ? ({ includeFontPadding: false } as const) : undefined;

export type TextProps = RNTextProps & { variant?: TypeName; color?: PaletteName };

// 모든 글은 이 컴포넌트로 쓴다. 시스템 글꼴, Dynamic Type 을 따르되 최대 1.6배까지만 키워 레이아웃이 깨지지 않게 한다.
export const Text = memo(function Text({ variant = "body", color = "text", style, ...rest }: TextProps) {
  const colors = useColors();
  return <RNText allowFontScaling maxFontSizeMultiplier={1.6} style={[type[variant], { color: colors[color] }, androidMetrics, style]} {...rest} />;
});
