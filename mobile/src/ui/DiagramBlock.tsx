import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { diagramDocument, diagramStyle, styledDiagram } from "../logic/diagram";
import type { Preview } from "../logic/previews";
import { palette } from "../theme/tokens.generated";
import { radius, spacing, useColors } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

type Rendered = { svg: string; height: number } | "failed";

const RENDERED_LIMIT = 40;
const rendered = new Map<string, Rendered>();
const PLACEHOLDER_HEIGHT = 120;

function remember(key: string, value: Rendered) {
  rendered.delete(key);
  rendered.set(key, value);
  if (rendered.size > RENDERED_LIMIT) rendered.delete(rendered.keys().next().value as string);
}

export type DiagramBlockProps = { code: string; marginBottom: number; itemId: string; onOpen?: (file: Preview) => void; renderCode: (marginBottom: number) => ReactNode };

export function DiagramBlock({ code, marginBottom, itemId, onOpen, renderCode }: DiagramBlockProps) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const style = useMemo(() => diagramStyle(colors), [colors]);
  const key = `${width}:${style}:${code}`;
  const [result, setResult] = useState<{ key: string; value: Rendered }>();
  const value = result?.key === key ? result.value : rendered.get(key);
  const source = useMemo(() => ({ html: diagramDocument(code, style), baseUrl: "about:blank" }), [code, style]);
  if (value === "failed") return <>{renderCode(marginBottom)}</>;
  const onMessage = (event: WebViewMessageEvent) => {
    let message: { failed?: boolean; svg?: string; height?: number };
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    const next: Rendered = message.failed || !message.svg || !message.height ? "failed" : { svg: message.svg, height: message.height };
    remember(key, next);
    setResult({ key, value: next });
  };
  const open = () => {
    if (!value || !onOpen) return;
    onOpen({ itemId, kind: "svg", title: "Diagram", content: { kind: "svg", text: styledDiagram(value.svg, diagramStyle(palette.light)) } });
  };
  return (
    <View style={{ marginBottom }}>
      <View style={[styles.card, { backgroundColor: colors.codeBackground, borderColor: colors.separator }, showCode && styles.joined]}>
        <View style={styles.header}>
          <Text variant="caption" color="textMuted" style={styles.label}>Diagram</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={showCode ? "Hide code" : "Show code"} accessibilityState={{ selected: showCode }} hitSlop={8} onPress={() => setShowCode((shown) => !shown)} style={styles.tool}>
            <Text variant="caption" color={showCode ? "accentText" : "textMuted"}>Code</Text>
          </Pressable>
          {!!onOpen && (
            <Pressable accessibilityRole="button" accessibilityLabel="Open diagram full size" hitSlop={8} disabled={!value} onPress={open} style={styles.tool}>
              <Icon name="arrow.up.left.and.arrow.down.right" size={14} color="textMuted" />
            </Pressable>
          )}
        </View>
        <Pressable accessibilityRole="imagebutton" accessibilityLabel="Diagram" disabled={!value || !onOpen} onPress={open} onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))} style={styles.body}>
          <View pointerEvents="none" style={{ height: value ? value.height : PLACEHOLDER_HEIGHT }}>
            {width > 0 && (
              <WebView key={key} source={source} javaScriptEnabled onMessage={onMessage} scrollEnabled={false}
                style={{ backgroundColor: "transparent", opacity: value ? 1 : 0 }} forceDarkOn={false} originWhitelist={["*"]}
                onShouldStartLoadWithRequest={(r) => r.url === "about:blank"} onOpenWindow={() => {}}
                allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} domStorageEnabled={false} geolocationEnabled={false} incognito mixedContentMode="never" />
            )}
          </View>
        </Pressable>
      </View>
      {showCode && renderCode(0)}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  joined: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottomWidth: 0 },
  header: { flexDirection: "row", alignItems: "center", minHeight: 36, paddingLeft: spacing.md },
  label: { flex: 1 },
  tool: { minHeight: 36, minWidth: 44, paddingHorizontal: spacing.md, alignItems: "center", justifyContent: "center" },
  body: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
});
