import { memo } from "react";
import { Platform, Text as RNText, type TextProps as RNTextProps } from "react-native";
import { type PaletteName } from "../theme/tokens.generated";
import { type, useColors, type TypeName } from "../theme/theme";

const androidMetrics = Platform.OS === "android" ? ({ includeFontPadding: false } as const) : undefined;

export type TextProps = RNTextProps & { variant?: TypeName; color?: PaletteName };

export const Text = memo(function Text({ variant = "body", color = "text", style, ...rest }: TextProps) {
  const colors = useColors();
  return <RNText allowFontScaling maxFontSizeMultiplier={1.6} style={[type[variant], { color: colors[color] }, androidMetrics, style]} {...rest} />;
});
