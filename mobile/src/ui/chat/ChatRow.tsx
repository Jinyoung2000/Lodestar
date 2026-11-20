import { memo } from "react";
import { Image, StyleSheet, View } from "react-native";
import type { Row } from "../../logic/timeline";
import { radius, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { MarkdownView } from "../MarkdownView";
import { Text } from "../Text";
import { AnsweredRow, ApprovalCard, PlanCard, QuestionCard, type Actions } from "./Cards";
import { StepsRow } from "./StepsRow";

// 타임라인 행 하나를 그린다. FlashList 가 행을 재활용하므로 행 종류(type)로 getItemType 을 준다.
export const ChatRow = memo(function ChatRow({ row, actions }: { row: Row; actions: Actions }) {
  const colors = useColors();
  switch (row.type) {
    case "user": {
      const item = row.item;
      const images = (item.attachments ?? []).filter((a): a is Extract<NonNullable<typeof item.attachments>[number], { kind: "image" }> => a.kind === "image");
      const chips = (item.attachments ?? []).filter((a) => a.kind !== "image" && a.kind !== "screenshot");
      const text = item.shown ?? item.text;
      return (
        <View style={styles.userWrap}>
          <View style={[styles.userBubble, { backgroundColor: colors.userBubble }]}>
            {images.length > 0 && (
              <View style={styles.thumbs}>
                {images.map((image) => (
                  <Image key={image.id} source={{ uri: image.thumb }} accessibilityLabel={image.label} style={[styles.thumb, { backgroundColor: colors.surfaceBase }]} />
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
          {row.item.text ? <MarkdownView text={row.item.text} /> : <Text color="textMuted">…</Text>}
        </View>
      );
    case "steps":
      return <StepsRow steps={row.steps} running={row.running} failed={row.failed} />;
    // 카드는 항목 id 로 새로 만든다. FlashList 는 같은 종류의 행 컴포넌트를 다른 항목에 다시 쓰므로, 그대로 두면 앞 요청의 바쁨 표시와 고른 답이 다음 요청 카드에 남는다.
    case "approval":
      return <ApprovalCard key={row.item.id} item={row.item} tool={row.tool} reviewOnDesktop={row.reviewOnDesktop} actions={actions} />;
    case "question":
      return <QuestionCard key={row.item.id} item={row.item} actions={actions} />;
    case "plan":
      return <PlanCard key={row.item.id} item={row.item} actions={actions} />;
    case "answered":
      return <AnsweredRow item={row.item} />;
    case "notice":
      return (
        <View style={styles.notice}>
          <Text variant="secondary" color="textMuted" style={{ textAlign: "center" }}>{row.text}</Text>
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

export const rowType = (row: Row) => (row.type === "user" ? "user" : row.type === "assistant" ? "assistant" : row.type === "steps" ? "steps" : row.type === "approval" || row.type === "question" || row.type === "plan" ? "card" : "small");

const styles = StyleSheet.create({
  userWrap: { alignItems: "flex-end" },
  userBubble: { maxWidth: "88%", borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
  thumbs: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  thumb: { width: 72, height: 72, borderRadius: radius.sm },
  assistant: { paddingRight: spacing.sm },
  notice: { paddingVertical: spacing.xs },
  error: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start", borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
});
