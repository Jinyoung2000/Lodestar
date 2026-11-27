import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import type { MobilePreview } from "@shared/mobile";
import { csvRows, numericColumns } from "../logic/previewDocuments";
import type { Preview } from "../logic/previews";
import { client, useAppState } from "../state/app";
import { spacing, useColors } from "../theme/theme";
import { MarkdownView } from "./MarkdownView";
import { Icon } from "./Icon";
import { Text } from "./Text";

export const previewGlyph = { html: "rectangle.and.hand.point.up.left", svg: "scribble.variable", image: "photo", csv: "tablecells", markdown: "doc.text", video: "film" } as const;
const thumbnails = new Map<string, { content: MobilePreview; expires: number }>();
const requests = new Map<string, Promise<MobilePreview>>();
const thumbnailLimit = 4;
const thumbnailLifetimeMs = 10 * 60_000;
const thumbnailCacheChars = 16 * 1024 * 1024;
let thumbnailChars = 0;

function contentChars(content: MobilePreview) {
  return "uri" in content ? content.uri.length : "html" in content ? content.html.length : content.text.length;
}

function forgetThumbnail(key: string) {
  const entry = thumbnails.get(key);
  if (!entry) return;
  thumbnails.delete(key);
  thumbnailChars -= contentChars(entry.content);
}

function rememberThumbnail(key: string, content: MobilePreview) {
  forgetThumbnail(key);
  thumbnails.set(key, { content, expires: Date.now() + thumbnailLifetimeMs });
  thumbnailChars += contentChars(content);
  for (const oldest of thumbnails.keys()) {
    if (thumbnailChars <= thumbnailCacheChars || thumbnails.size <= 1) break;
    forgetThumbnail(oldest);
  }
}

function cacheKey(agentId: string, itemId: string, target: string) {
  return JSON.stringify([agentId, itemId, target]);
}

export function cachedThumbnail(agentId: string, itemId: string, target: string) {
  const key = cacheKey(agentId, itemId, target);
  const entry = thumbnails.get(key);
  if (!entry) return;
  if (entry.expires < Date.now()) {
    forgetThumbnail(key);
    return;
  }
  thumbnails.delete(key);
  thumbnails.set(key, entry);
  return entry.content;
}

export function cachedFullPreview(agentId: string, itemId: string, target: string) {
  const content = cachedThumbnail(agentId, itemId, target);
  return content?.kind === "image" && content.reduced ? undefined : content;
}

function useThumbnail(agentId: string | undefined, file: Preview, enabled: boolean) {
  const target = "target" in file ? file.target : undefined;
  const itemId = file.itemId;
  const conn = useAppState(state => state.conn);
  const key = agentId && target ? cacheKey(agentId, itemId, target) : undefined;
  const [loaded, setLoaded] = useState<{ key: string; content: MobilePreview }>();
  useEffect(() => {
    if (!enabled || file.thumb || file.kind === "video" || !agentId || !target || !key) return;
    let active = true;
    async function load() {
      if (!agentId || !target || !key) return;
      const saved = cachedThumbnail(agentId, itemId, target);
      if (saved) {
        setLoaded({ key, content: saved });
        return;
      }
      if (conn !== "online") return;
      while (active && !requests.has(key) && requests.size >= thumbnailLimit) {
        await Promise.race([...requests.values()].map(request => request.catch(() => undefined)));
      }
      if (!active) return;
      let request = requests.get(key);
      if (!request) {
        request = client.call("mobile.preview", { agentId, itemId, target, thumb: true }).then(content => {
          rememberThumbnail(key, content);
          return content;
        }).finally(() => requests.delete(key));
        requests.set(key, request);
      }
      try {
        const content = await request;
        if (active) setLoaded({ key, content });
      } catch {}
    }
    void load();
    return () => { active = false; };
  }, [agentId, conn, enabled, file.thumb, itemId, key, target]);
  if (file.thumb?.startsWith("data:image/")) return { kind: "image", uri: file.thumb } as const;
  const content = "content" in file ? file.content : loaded?.key === key ? loaded?.content : undefined;
  return content?.kind === "image" && !/^data:image\/|^https:\/\//i.test(content.uri) ? undefined : content;
}

export function PreviewThumbnail({ agentId, file, visible = true, renderDocument, onImageSize }: {
  agentId?: string;
  file: Preview;
  visible?: boolean;
  onImageSize?: (width: number, height: number) => void;
  renderDocument: (content: MobilePreview, title: string, width: number, height: number) => React.ReactNode;
}) {
  const colors = useColors();
  const content = useThumbnail(agentId, file, visible);
  const [failedUri, setFailedUri] = useState<string>();
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const scale = width / 320;
  return <View onLayout={({ nativeEvent: { layout } }) => setSize(layout)} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.cover, { backgroundColor: colors.surfaceBase }]}>
    {visible && content?.kind === "image" && content.uri !== failedUri
      ? <Image source={{ uri: content.uri }} resizeMode="cover" onLoad={({ nativeEvent: { source } }) => onImageSize?.(source.width, source.height)} onError={() => setFailedUri(content.uri)} style={StyleSheet.absoluteFill} />
      : visible && width > 0 && height > 0 && (content?.kind === "markdown" || content?.kind === "csv")
        ? <View style={[styles.nativeDocument, { height: height / scale, transform: [{ scale }] }]}>
          {content.kind === "markdown" ? <View style={styles.markdown}><MarkdownView text={content.text.slice(0, 500)} selectable={false} /></View>
            : <TableCover text={content.text} />}
        </View>
        : visible && width > 0 && height > 0 && content && content.kind !== "image"
          ? renderDocument(content, file.title, width, height)
          : <View style={styles.fallback}><Icon name={previewGlyph[file.kind]} color="textSubtle" size={20} /></View>}
  </View>;
}

function TableCover({ text }: { text: string }) {
  const colors = useColors();
  const { rows } = csvRows(text, 7);
  const numeric = numericColumns(rows);
  const columns = Array.from({ length: Math.min(4, Math.max(0, ...rows.map((row) => row.length))) }, (_, column) => column);
  return <View>{rows.map((row, index) =>
    <View key={index} style={[styles.csvRow, { borderColor: colors.separator, backgroundColor: index === 0 ? colors.surfaceBase : colors.surface }]}>
      {columns.map((column) => <Text key={column} color={index === 0 ? "textStrong" : "text"} numberOfLines={1} style={[
        styles.cell, index === 0 && styles.heading, numeric.has(column) && styles.number,
      ]}>{row[column] ?? ""}</Text>)}
    </View>)}</View>;
}

const styles = StyleSheet.create({
  cover: { flex: 1, overflow: "hidden" },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  nativeDocument: { position: "absolute", left: 0, top: 0, width: 320, overflow: "hidden", transformOrigin: "top left" },
  markdown: { padding: spacing.lg },
  csvRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { flex: 1, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  heading: { fontWeight: "600" },
  number: { textAlign: "right", fontVariant: ["tabular-nums"] },
});
