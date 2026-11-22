import { useRecyclingState } from "@shopify/flash-list";
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { Step, ToolItem } from "../../logic/timeline";
import { describeTool } from "../../logic/tools";
import { radius, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

type Props = { steps: Step[]; running: boolean; failed: boolean };

export const StepsRow = memo(function StepsRow({ steps, running, failed }: Props) {
  const colors = useColors();
  const [open, setOpen] = useRecyclingState(false, [steps[0]?.id]);
  const tools = steps.filter((s): s is ToolItem => s.kind === "tool");
  const active = [...tools].reverse().find((t) => t.status === "running") ?? tools[tools.length - 1];
  const line = active ? describeTool(active.name, active.input, active.status !== "running") : null;
  const label = tools.length === 0 ? "Thinking" : tools.length === 1 || running ? `${line!.verb}${line!.detail ? ` ${line!.detail}` : ""}` : `${tools.length} steps`;
  const sub = tools.length > 1 && !running && line ? `${line.verb}${line.detail ? ` ${line.detail}` : ""}` : null;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}. ${open ? "Collapse" : "Expand"}`} accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={styles.header}>
        <View style={styles.status}>{running ? <ActivityIndicator size="small" color={colors.running} /> : failed ? <Icon name="xmark.circle.fill" size={18} color="danger" /> : <Icon name={tools.length === 0 ? "ellipsis" : "checkmark.circle"} size={18} color="textMuted" />}</View>
        <View style={{ flex: 1 }}>
          <Text variant="secondary" color="textStrong" numberOfLines={1}>
            {label}
          </Text>
          {sub && (
            <Text variant="caption" color="textMuted" numberOfLines={1}>
              {sub}
            </Text>
          )}
        </View>
        <Icon name={open ? "chevron.up" : "chevron.down"} size={14} color="textSubtle" />
      </Pressable>
      {open && (
        <View style={[styles.list, { borderTopColor: colors.separator }]}>
          {steps.map((step) => (
            <StepLine key={step.id} step={step} />
          ))}
        </View>
      )}
    </View>
  );
});

function StepLine({ step }: { step: Step }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  if (step.kind === "thinking") {
    return (
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.line} accessibilityRole="button">
        <Text variant="secondary" color="textMuted" numberOfLines={open ? undefined : 1} style={{ fontStyle: "italic" }}>
          {open ? step.text : `Thinking: ${step.text.replace(/\s+/g, " ")}`}
        </Text>
      </Pressable>
    );
  }
  const { verb, detail } = describeTool(step.name, step.input, step.status !== "running");
  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.line} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View style={{ width: 16, marginRight: spacing.sm }}>{step.status === "running" ? <ActivityIndicator size="small" color={colors.running} /> : step.status === "error" ? <Icon name="xmark" size={12} color="danger" /> : <Icon name="checkmark" size={12} color="textSubtle" />}</View>
        <Text variant="secondary" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
          <Text variant="secondary" color="text" style={{ fontWeight: "600" }}>{verb}</Text>
          {detail ? `  ${detail}` : ""}
        </Text>
      </Pressable>
      {open && <StepDetail step={step} />}
    </View>
  );
}

const DETAIL_LINES = 30;

function StepDetail({ step }: { step: ToolItem }) {
  const colors = useColors();
  const input = detailText(step.input);
  const output = step.output ? clipLines(step.output, DETAIL_LINES) : null;
  return (
    <View style={[styles.detail, { backgroundColor: colors.surfaceBase, borderColor: colors.separator }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        <View>
          <Text variant="caption" color="textSubtle">Input</Text>
          <Text variant="mono" selectable style={{ fontSize: 12, lineHeight: 18 }}>{input}</Text>
          {output !== null && (
            <>
              <Text variant="caption" color="textSubtle" style={{ marginTop: spacing.sm }}>Output</Text>
              <Text variant="mono" selectable style={{ fontSize: 12, lineHeight: 18 }}>{output}</Text>
            </>
          )}
          {step.status === "running" && <Text variant="caption" color="textSubtle" style={{ marginTop: spacing.sm }}>Running…</Text>}
        </View>
      </ScrollView>
    </View>
  );
}

function detailText(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 1 && typeof entries[0][1] === "string") return clipLines(entries[0][1] as string, DETAIL_LINES);
  return clipLines(entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n"), DETAIL_LINES);
}

function clipLines(text: string, max: number) {
  const lines = text.split("\n");
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines` : text;
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", minHeight: 48, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  status: { width: 22, alignItems: "center" },
  list: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.xs },
  line: { flexDirection: "row", alignItems: "center", minHeight: 36, paddingHorizontal: spacing.md },
  detail: { marginHorizontal: spacing.md, marginBottom: spacing.sm, padding: spacing.sm, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
});
