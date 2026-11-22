import { memo } from "react";
import { Pressable, Image, StyleSheet, View } from "react-native";
import type { Row } from "../../logic/timeline";
import { messagePreviews, type Preview } from "../../logic/previews";
import { PreviewRow } from "../Preview";
import { radius, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { MarkdownView } from "../MarkdownView";
import { Text } from "../Text";
import { AnsweredRow } from "./Cards";
import { StepsRow } from "./StepsRow";

export const ChatRow = memo(function ChatRow({ row, showGallery, openPreview, agentId }: { row: Row; agentId: string; showGallery: () => void; openPreview: (file: Preview) => void }) {
  const colors = useColors();
  switch (row.type) {
    case "user": {
      const item = row.item;
      const images = messagePreviews(item);
      const chips = (item.attachments ?? []).filter((a) => a.kind !== "image" && a.kind !== "screenshot");
      const text = item.shown ?? item.text;
      const imageOnly = images.length > 0 && !chips.length && !text.trim();
      return (
        <View style={styles.userWrap}>
          <View style={imageOnly ? styles.imageBubble : [styles.userBubble, { backgroundColor: colors.userBubble }]}>
            {images.length > 0 && (
              <View style={styles.thumbs}>
                {images.map((image, index) => (
                  <Pressable key={index} accessibilityRole="button" accessibilityLabel={`Open ${image.title}`} onPress={() => openPreview(image)}><Image source={{ uri: image.thumb }} style={[styles.thumb, imageOnly && images.length === 1 && styles.singleImage, { backgroundColor: colors.surfaceBase }]} /></Pressable>
                ))}
              </View>
            )}
            {chips.map((chip, i) => (
              <Text key={i} variant="caption" color="textMuted" numberOfLines={1}>{`@ ${"label" in chip ? chip.label : ""}`}</Text>
            ))}
            {!!text && <Text color="textStrong" selectable>{text}</Text>}
          </View>
        </View>
      );
    }
    case "assistant":
      return (
        <View style={styles.assistant}>
          {row.item.text ? <MarkdownView text={row.item.text} previewCards={!row.item.streaming} /> : <Text color="textMuted">…</Text>}
          <AttachmentGroup files={messagePreviews(row.item)} agentId={agentId} open={openPreview} showGallery={showGallery} />
        </View>
      );
    case "steps": {
      const files = row.steps.flatMap(messagePreviews);
      return <View style={{ gap: spacing.sm }}>
        <StepsRow steps={row.steps} decisions={row.decisions} running={row.running} failed={row.failed} />
        <AttachmentGroup files={files} agentId={agentId} open={openPreview} showGallery={showGallery} />
      </View>;
    }
    case "approval":
    case "question":
    case "plan":
      return null;
    case "answered":
      return <AnsweredRow item={row.item} />;
    case "notice":
      return (
        <View style={styles.notice}>
          <Text variant="caption" color="textSubtle" style={{ textAlign: "center" }}>{row.text}</Text>
        </View>
      );
    case "error":
      return (
        <View style={[styles.error, { borderColor: colors.danger }]}>
          <Icon name="exclamationmark.triangle" size={18} color="danger" />
          <Text variant="secondary" color="danger" selectable style={{ flex: 1 }}>{row.item.text}</Text>
        </View>
      );
  }
});

function AttachmentGroup({ files, agentId, open, showGallery }: { files: Preview[]; agentId: string; open: (file: Preview) => void; showGallery: () => void }) {
  const colors = useColors();
  if (!files.length) return null;
  const shown = files.slice(0, 3);
  return <View style={[styles.group, { borderColor: colors.separator, backgroundColor: colors.surface }]}>
    {shown.map((file, i) => <View key={i} style={[styles.fileLine, { borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.separator }]}>
      <View style={styles.file}><PreviewRow grouped file={file} agentId={agentId} open={open} /></View>
    </View>)}
    {files.length > shown.length && <Pressable accessibilityRole="button" hitSlop={{ bottom: 4 }} onPress={showGallery} style={[styles.remainder, { borderTopColor: colors.separator }]}>
      <Text variant="secondary" color="accentText" style={{ fontSize: 13, fontWeight: "600" }}>{`Show all ${files.length}`}</Text>
    </Pressable>}
  </View>;
}

export const rowType = (row: Row) => (row.type === "user" ? "user" : row.type === "assistant" ? "assistant" : row.type === "steps" ? "steps" : row.type === "approval" || row.type === "question" || row.type === "plan" ? "card" : "small");

const styles = StyleSheet.create({
  userWrap: { alignItems: "flex-end" },
  userBubble: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: spacing.xs },
  imageBubble: { maxWidth: "85%" },
  singleImage: { width: 160, height: 160, borderRadius: 12 },
  thumbs: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  thumb: { width: 72, height: 72, borderRadius: radius.sm },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: "hidden" },
  fileLine: { flexDirection: "row", alignItems: "stretch" },
  file: { flex: 1, minWidth: 0 },
  remainder: { minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  assistant: { gap: spacing.sm },
  notice: { paddingVertical: spacing.xs },
  error: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start", borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
});
