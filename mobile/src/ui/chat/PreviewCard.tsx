import { memo, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { previewFrameDocument, readPreviewCard } from "../../logic/previewCard";
import type { Preview } from "../../logic/previews";
import type { ToolItem } from "../../logic/timeline";
import { MIN_TOUCH, radius, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

const FRAME_MAX_HEIGHT = 360;
const FRAME_MIN_HEIGHT = 48;
const HEADER_HEIGHT = 36;
const EXPAND_SIZE = 40;
const REPORT_HEIGHT = "(function(){var post=function(){window.ReactNativeWebView.postMessage(String(document.body.scrollHeight))};post();window.addEventListener('load',post);setTimeout(post,300)})();true;";

export type PreviewCardRowProps = { item: ToolItem; open: (file: Preview) => void };

export const htmlPreviewFile = (itemId: string, title: string, html: string): Preview => ({ itemId, kind: "html", title, content: { kind: "html", html: previewFrameDocument(html, "Canvas") } });

export const PreviewCardRow = memo(function PreviewCardRow({ item, open }: PreviewCardRowProps) {
  const colors = useColors();
  const card = useMemo(() => readPreviewCard(item.input), [item.input]);
  if (!card) return null;
  return (
    <View style={styles.card}>
      {!!card.title && <Text variant="secondary" color="textStrong" style={styles.title}>{card.title}</Text>}
      {card.frames.map((frame, index) => {
        const label = frame.label || `Preview ${index + 1}`;
        return (
          <Pressable key={index} accessibilityRole="button" accessibilityLabel={`Open ${label}`} onPress={() => open(htmlPreviewFile(item.id, label, frame.html))}
            style={({ pressed }) => [styles.frame, { borderColor: colors.separator, backgroundColor: pressed ? colors.pressed : colors.surface }]}>
            <View style={[styles.header, { borderBottomColor: colors.separator }]}>
              <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.label}>{label}</Text>
              <Icon name="arrow.up.left.and.arrow.down.right" size={16} color="textSubtle" />
            </View>
            <HtmlFrameView html={frame.html} />
          </Pressable>
        );
      })}
    </View>
  );
});

export function HtmlFrameView({ html, maxHeight = FRAME_MAX_HEIGHT }: { html: string; maxHeight?: number }) {
  const document = useMemo(() => previewFrameDocument(html, "Canvas"), [html]);
  const source = useMemo(() => ({ html: document, baseUrl: "about:blank" }), [document]);
  const [height, setHeight] = useState<number | null>(null);
  const onMessage = (event: WebViewMessageEvent) => {
    const next = Number(event.nativeEvent.data);
    if (Number.isFinite(next) && next > 0) setHeight(Math.max(FRAME_MIN_HEIGHT, Math.min(maxHeight, Math.ceil(next))));
  };
  return (
    <View pointerEvents="none" style={{ height: height ?? FRAME_MIN_HEIGHT * 2 }}>
      <WebView source={source} javaScriptEnabled injectedJavaScript={REPORT_HEIGHT} onMessage={onMessage} scrollEnabled={false}
        style={{ backgroundColor: "transparent", opacity: height === null ? 0 : 1 }} forceDarkOn={false} originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url === "about:srcdoc"} onOpenWindow={() => {}}
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} domStorageEnabled={false} geolocationEnabled={false} incognito mixedContentMode="never" />
    </View>
  );
}

export function ExpandButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${label} full size`} hitSlop={(MIN_TOUCH - EXPAND_SIZE) / 2} onPress={onPress} style={styles.expand}>
      <Icon name="arrow.up.left.and.arrow.down.right" size={18} color="textMuted" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  title: { fontWeight: "600" },
  frame: { overflow: "hidden", borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, height: HEADER_HEIGHT, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { flex: 1, fontWeight: "600" },
  expand: { width: EXPAND_SIZE, height: EXPAND_SIZE, alignItems: "center", justifyContent: "center" },
});
