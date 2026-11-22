import { memo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { PermissionItem, ToolItem } from "../../logic/timeline";
import { answersOf, emptyQuestionState, isAnswered, planText, readQuestions, toggleOther, togglePick, type QuestionState } from "../../logic/questions";
import { approvalTarget, describeTool, shortPath } from "../../logic/tools";
import { MIN_TOUCH, radius, spacing, useColors, withAlpha } from "../../theme/theme";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { MarkdownView } from "../MarkdownView";
import { Text } from "../Text";

export type Actions = {
  allow: (itemId: string) => Promise<unknown>;
  deny: (itemId: string) => Promise<unknown>;
  answer: (itemId: string, answers: Record<string, string> | null) => Promise<unknown>;
  plan: (itemId: string, decision: { approve: true; mode: "acceptEdits" | "default" } | { approve: false; feedback?: string }) => Promise<unknown>;
};

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    action().catch((e: Error) => {
      setBusy(null);
      setError(e.message);
    });
  };
  return { busy, error, run };
}

const MAX_DIFF_LINES = 14;
const PLAN_PREVIEW_HEIGHT = 220;
const clip = (text: string, max = MAX_DIFF_LINES) => {
  const lines = text.split("\n");
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines` : text;
};

export const ApprovalCard = memo(function ApprovalCard({ item, tool, reviewOnDesktop, actions }: { item: PermissionItem; tool: ToolItem | null; reviewOnDesktop: boolean; actions: Actions }) {
  const colors = useColors();
  const { busy, error, run } = useBusy();
  const input = item.input;
  const target = approvalTarget(item.toolName, input);
  const { verb } = describeTool(item.toolName, input, false);
  const isEdit = item.toolName === "Edit" || item.toolName === "MultiEdit";
  const edits = isEdit ? (Array.isArray(input.edits) ? (input.edits as { old_string?: string; new_string?: string }[]) : [{ old_string: String(input.old_string ?? ""), new_string: String(input.new_string ?? "") }]) : [];
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: withAlpha(colors.warning, 0.6) }]}>
      <View style={styles.cardHead}>
        <Icon name="exclamationmark.shield" size={20} color="warning" />
        <Text variant="title" color="textStrong" style={{ flex: 1 }} numberOfLines={2}>
          {reviewOnDesktop ? "Review on your Mac" : `${verb} ${item.toolName === "Bash" ? "this command" : tool ? "" : item.toolName}`.trim()}
          {!reviewOnDesktop && "?"}
        </Text>
      </View>
      {target && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.code, { backgroundColor: colors.surfaceBase, borderColor: colors.separator }]} nestedScrollEnabled>
          <Text variant="mono" selectable style={{ fontSize: 14, lineHeight: 21 }}>
            {target.kind === "path" ? shortPath(target.text) : clip(target.text, 10)}
          </Text>
        </ScrollView>
      )}
      {target?.kind === "path" && <Text variant="caption" color="textMuted" selectable>{target.text}</Text>}
      {edits.slice(0, 3).map((edit, i) => (
        <View key={i} style={{ gap: 2 }}>
          {!!edit.old_string && (
            <View style={[styles.code, { backgroundColor: colors.diffDelete, borderColor: "transparent" }]}>
              <Text variant="mono" style={{ fontSize: 12, lineHeight: 18 }}>{clip(edit.old_string)}</Text>
            </View>
          )}
          {!!edit.new_string && (
            <View style={[styles.code, { backgroundColor: colors.diffAdd, borderColor: "transparent" }]}>
              <Text variant="mono" style={{ fontSize: 12, lineHeight: 18 }}>{clip(edit.new_string)}</Text>
            </View>
          )}
        </View>
      ))}
      {item.toolName === "Write" && typeof input.content === "string" && (
        <View style={[styles.code, { backgroundColor: colors.diffAdd, borderColor: "transparent" }]}>
          <Text variant="mono" style={{ fontSize: 12, lineHeight: 18 }}>{clip(input.content)}</Text>
        </View>
      )}
      {!target && !isEdit && item.toolName !== "Write" && Object.keys(input).length > 0 && (
        <Text variant="mono" color="textMuted" numberOfLines={6} style={{ fontSize: 12, lineHeight: 18 }}>{JSON.stringify(input, null, 1)}</Text>
      )}
      {reviewOnDesktop ? (
        <Text variant="secondary" color="textMuted">This change to Notion needs a closer look. Approve it in Lodestar on your Mac.</Text>
      ) : (
        <View style={styles.actions}>
          <Button title="Deny" flex busy={busy === "deny"} disabled={busy !== null && busy !== "deny"} onPress={() => run("deny", () => actions.deny(item.id))} />
          <Button title="Allow" kind="primary" flex busy={busy === "allow"} disabled={busy !== null && busy !== "allow"} onPress={() => run("allow", () => actions.allow(item.id))} />
        </View>
      )}
      {error && <Text variant="secondary" color="danger">{error}</Text>}
    </View>
  );
});

export const QuestionCard = memo(function QuestionCard({ item, actions }: { item: PermissionItem; actions: Actions }) {
  const colors = useColors();
  const questions = readQuestions(item.input);
  const [states, setStates] = useState<QuestionState[]>(() => questions.map(emptyQuestionState));
  const { busy, error, run } = useBusy();
  const update = (index: number, next: QuestionState) => setStates((all) => all.map((s, i) => (i === index ? next : s)));
  const ready = isAnswered(questions, states);
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: withAlpha(colors.accent, 0.7) }]}>
      {questions.map((q, qi) => {
        const state = states[qi] ?? emptyQuestionState();
        return (
          <View key={qi} style={{ gap: spacing.sm }}>
            {!!q.header && (
              <Text variant="caption" color="accentText" style={{ textTransform: "uppercase", letterSpacing: 0.5 }}>
                {q.header}
              </Text>
            )}
            <Text variant="bodyStrong" color="textStrong">{q.question}</Text>
            {q.multiSelect && <Text variant="caption" color="textMuted">Choose any that apply</Text>}
            {q.options.map((option) => {
              const on = state.picked.includes(option.label);
              return (
                <Pressable key={option.label} accessibilityRole={q.multiSelect ? "checkbox" : "radio"} accessibilityState={{ checked: on }} onPress={() => update(qi, togglePick(q, state, option.label))} style={[styles.option, { borderColor: on ? colors.accent : colors.border, backgroundColor: on ? withAlpha(colors.accent, 0.14) : "transparent" }]}>
                  <Icon name={on ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle") : q.multiSelect ? "square" : "circle"} size={20} color={on ? "accentText" : "textSubtle"} />
                  <View style={{ flex: 1 }}>
                    <Text color="textStrong">{option.label}</Text>
                    {!!option.description && <Text variant="secondary" color="textMuted">{option.description}</Text>}
                  </View>
                </Pressable>
              );
            })}
            <Pressable accessibilityRole={q.multiSelect ? "checkbox" : "radio"} accessibilityState={{ checked: state.other }} onPress={() => update(qi, toggleOther(q, state))} style={[styles.option, { borderColor: state.other ? colors.accent : colors.border, backgroundColor: state.other ? withAlpha(colors.accent, 0.14) : "transparent" }]}>
              <Icon name={state.other ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle") : q.multiSelect ? "square" : "circle"} size={20} color={state.other ? "accentText" : "textSubtle"} />
              <Text color="textStrong">Other</Text>
            </Pressable>
            {state.other && <TextInput value={state.text} onChangeText={(text) => update(qi, { ...state, text })} placeholder="Type your answer" placeholderTextColor={colors.textSubtle} multiline style={[styles.input, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]} />}
          </View>
        );
      })}
      <View style={styles.actions}>
        <Button title="Skip" flex busy={busy === "skip"} disabled={busy !== null && busy !== "skip"} onPress={() => run("skip", () => actions.answer(item.id, null))} />
        <Button title="Send answer" kind="primary" flex disabled={!ready || (busy !== null && busy !== "send")} busy={busy === "send"} onPress={() => run("send", () => actions.answer(item.id, answersOf(questions, states)))} />
      </View>
      {error && <Text variant="secondary" color="danger">{error}</Text>}
    </View>
  );
});

export const PlanCard = memo(function PlanCard({ item, actions }: { item: PermissionItem; actions: Actions }) {
  const colors = useColors();
  const { busy, error, run } = useBusy();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const plan = planText(item.input);
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: withAlpha(colors.accent, 0.7) }]}>
      <View style={styles.cardHead}>
        <Icon name="list.bullet.clipboard" size={20} color="accentText" />
        <Text variant="title" color="textStrong">Plan ready</Text>
      </View>
      {plan ? (
        <View>
          <View style={expanded ? undefined : { maxHeight: PLAN_PREVIEW_HEIGHT, overflow: "hidden" }}>
            <MarkdownView text={plan} />
          </View>
          <Pressable accessibilityRole="button" onPress={() => setExpanded((v) => !v)} style={{ minHeight: MIN_TOUCH, justifyContent: "center" }}>
            <Text color="accentText">{expanded ? "Show less" : "Read the full plan"}</Text>
          </Pressable>
        </View>
      ) : (
        <Text color="textMuted">The plan is on your Mac.</Text>
      )}
      {feedback === null ? (
        <View style={{ gap: spacing.sm }}>
          <Button title="Approve and edit automatically" kind="primary" busy={busy === "auto"} disabled={busy !== null && busy !== "auto"} onPress={() => run("auto", () => actions.plan(item.id, { approve: true, mode: "acceptEdits" }))} />
          <Button title="Approve, ask before each edit" busy={busy === "ask"} disabled={busy !== null && busy !== "ask"} onPress={() => run("ask", () => actions.plan(item.id, { approve: true, mode: "default" }))} />
          <Button title="Keep planning" kind="plain" disabled={busy !== null} onPress={() => setFeedback("")} />
        </View>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <TextInput autoFocus value={feedback} onChangeText={setFeedback} placeholder="What should change in the plan?" placeholderTextColor={colors.textSubtle} multiline style={[styles.input, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]} />
          <View style={styles.actions}>
            <Button title="Cancel" flex onPress={() => setFeedback(null)} />
            <Button title="Send" kind="primary" flex busy={busy === "keep"} onPress={() => run("keep", () => actions.plan(item.id, { approve: false, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }))} />
          </View>
        </View>
      )}
      {error && <Text variant="secondary" color="danger">{error}</Text>}
    </View>
  );
});

export const AnsweredRow = memo(function AnsweredRow({ item }: { item: PermissionItem }) {
  const colors = useColors();
  const answers = item.outcome?.answers;
  const plan = item.outcome?.plan;
  const text = answers
    ? Object.entries(answers).map(([q, a]) => `${q}  ${a}`).join("\n")
    : plan
      ? plan.decision === "approved"
        ? "Plan approved"
        : `Kept planning${plan.feedback ? `: ${plan.feedback}` : ""}`
      : item.status === "denied"
        ? "Skipped"
        : "Answered";
  return (
    <View style={[styles.answered, { backgroundColor: colors.userBubble }]}>
      <Text variant="secondary" color="textMuted" selectable>{text}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1.5, padding: spacing.lg, gap: spacing.md },
  cardHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  code: { borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, padding: spacing.sm },
  actions: { flexDirection: "row", gap: spacing.sm },
  option: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: MIN_TOUCH + 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1 },
  input: { minHeight: 80, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, fontSize: 16, lineHeight: 22, textAlignVertical: "top" },
  answered: { borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, alignSelf: "flex-start", maxWidth: "92%" },
});
