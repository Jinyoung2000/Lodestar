import { useRecyclingState } from "@shopify/flash-list";
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { PermissionItem, Step, ToolItem } from "../../logic/timeline";
import { QUESTION_TOOL } from "../../logic/questions";
import { describeTool } from "../../logic/tools";
import { radius, spacing, useColors } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

type Props = { steps: Step[]; decisions: PermissionItem[]; running: boolean; failed: boolean };

export const StepsRow = memo(function StepsRow({ steps, decisions, running, failed }: Props) {
  const colors = useColors();
  const [open, setOpen] = useRecyclingState(false, [steps[0]?.id]);
  const tools = steps.filter((s): s is ToolItem => s.kind === "tool");
  const active = [...tools].reverse().find((t) => t.status === "running") ?? tools[tools.length - 1];
  const line = active ? describeTool(active.name, active.input, active.status !== "running") : null;
  const label = tools.length === 0 ? (steps.some((step) => step.kind === "permission") ? "Tool activity" : "Thinking") : tools.length === 1 || running ? `${line!.verb}${line!.detail ? ` ${line!.detail}` : ""}` : `${tools.length} steps`;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}. ${open ? "Collapse" : "Expand"}`} accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} hitSlop={{ top: 4, bottom: 4 }} style={styles.header}>
        <View style={styles.status}>{running ? <ActivityIndicator size="small" color={colors.running} /> : failed ? <Icon name="xmark.circle.fill" size={14} color="danger" /> : <Icon name={tools.length === 0 ? "ellipsis" : "checkmark.circle"} size={14} color="textMuted" />}</View>
        <View style={{ flex: 1 }}>
          <Text variant="secondary" color="textMuted" numberOfLines={1} style={styles.label}>
            {label}
          </Text>
        </View>
        <Icon name={open ? "chevron.up" : "chevron.down"} size={12} color="textSubtle" />
      </Pressable>
      {open && (
        <View style={[styles.list, { borderTopColor: colors.separator }]}>
          {steps.map((step) => (
            <StepLine key={step.id} step={step} decision={decisions.find((item) => item.toolUseId === step.id)} />
          ))}
        </View>
      )}
    </View>
  );
});

function decisionLabel(item: PermissionItem) {
  const plan = item.outcome?.plan;
  if (plan?.decision === "approved") return "Plan approved";
  if (plan?.decision === "kept") return "Kept planning";
  if (item.status === "denied") return item.toolName === QUESTION_TOOL ? "Skipped" : "Denied";
  return item.auto ? "Auto-approved" : "Allowed";
}

function StepLine({ step, decision }: { step: Step; decision?: PermissionItem }) {
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
  if (step.kind === "permission") {
    const { verb, detail } = describeTool(step.toolName, step.input, false);
    const feedback = step.outcome?.plan?.decision === "kept" ? step.outcome.plan.feedback : null;
    return <View style={styles.line}>
      <View style={{ flex: 1 }}>
        <Text variant="secondary" color="textMuted" selectable>{[verb, detail].filter(Boolean).join(" ")}</Text>
        {!!feedback && <Text variant="secondary" selectable>{feedback}</Text>}
      </View>
      <Text variant="caption" color={step.status === "denied" ? "danger" : "textMuted"}>{decisionLabel(step)}</Text>
    </View>;
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
        {decision && <Text variant="caption" color={decision.status === "denied" ? "danger" : "textMuted"}>{decisionLabel(decision)}</Text>}
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
  label: { fontSize: 13, lineHeight: 18 },
  header: { flexDirection: "row", alignItems: "center", minHeight: 32, gap: spacing.sm },
  status: { width: 16, alignItems: "center" },
  list: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.xs },
  line: { flexDirection: "row", alignItems: "center", minHeight: 32, paddingHorizontal: spacing.sm },
  detail: { marginHorizontal: spacing.md, marginBottom: spacing.sm, padding: spacing.sm, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
});
