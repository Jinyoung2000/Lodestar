import { memo, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { PermissionItem, ToolItem } from "../../logic/timeline";
import { answersOf, emptyQuestionState, isAnswered, planText, readQuestions, QUESTION_TOOL, PLAN_TOOL, togglePick, type QuestionState } from "../../logic/questions";
import { approvalTarget, describeTool, shortPath } from "../../logic/tools";
import { MIN_TOUCH, radius, spacing, useColors, withAlpha } from "../../theme/theme";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { MarkdownView } from "../MarkdownView";
import { Text } from "../Text";
import { RequestDock, type DockLayout } from "./RequestDock";

export type Actions = {
  allow: (itemId: string) => Promise<unknown>;
  deny: (itemId: string) => Promise<unknown>;
  answer: (itemId: string, answers: Record<string, string> | null) => Promise<unknown>;
  plan: (itemId: string, decision: { approve: true; mode: "acceptEdits" | "default" } | { approve: false; feedback?: string }) => Promise<unknown>;
};

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = (key: string, action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setError(null);
    action().catch((e: Error) => {
      inFlight.current = false;
      setBusy(null);
      setError(e.message);
    });
  };
  return { busy, error, run };
}

const MAX_DIFF_LINES = 14;
const clip = (text: string, max = MAX_DIFF_LINES) => {
  const lines = text.split("\n");
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines` : text;
};

export const ApprovalCard = memo(function ApprovalCard({ item, tool, reviewOnDesktop, actions, ...layout }: DockLayout & { item: PermissionItem; tool: ToolItem | null; reviewOnDesktop: boolean; actions: Actions }) {
  const colors = useColors();
  const { busy, error, run } = useBusy();
  const input = item.input;
  const target = approvalTarget(item.toolName, input);
  const { verb } = describeTool(item.toolName, input, false);
  const isEdit = item.toolName === "Edit" || item.toolName === "MultiEdit";
  const edits = isEdit ? (Array.isArray(input.edits) ? (input.edits as { old_string?: string; new_string?: string }[]) : [{ old_string: String(input.old_string ?? ""), new_string: String(input.new_string ?? "") }]) : [];
  const summary = reviewOnDesktop ? "Review on your Mac" : `${verb} ${item.toolName === "Bash" ? "this command" : tool ? "" : item.toolName}`.trim() + "?";
  const locked = !!busy || layout.offline;
  return (
    <RequestDock {...layout} label={`Approval · ${item.toolName}`} summary={summary} warning busy={!!busy}
      footer={reviewOnDesktop ? null : <>
        {error && <Text variant="secondary" color="danger">{error}</Text>}
        <View style={styles.actions}>
          <Button title="Deny" kind="plain" flex style={{ minHeight: 40 }} busy={busy === "deny"} disabled={locked} onPress={() => run("deny", () => actions.deny(item.id))} />
          <Button title="Allow" kind="primary" style={{ flex: 2, minHeight: 40 }} busy={busy === "allow"} disabled={locked} onPress={() => run("allow", () => actions.allow(item.id))} />
        </View>
      </>}>
      <Text variant="bodyStrong" color="textStrong" style={{ fontSize: 15, lineHeight: 20 }}>{summary}</Text>
      {target && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.code, { backgroundColor: colors.surfaceBase, borderColor: colors.separator }]} nestedScrollEnabled>
          <Text variant="mono" selectable style={{ fontSize: 13, lineHeight: 18 }}>
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
      {reviewOnDesktop && <Text variant="secondary" color="textMuted">This change to Notion needs a closer look. Approve it in Lodestar on your Mac.</Text>}
    </RequestDock>
  );
});

export const QuestionCard = memo(function QuestionCard({ item, actions, ...layout }: DockLayout & { item: PermissionItem; actions: Actions }) {
  const colors = useColors();
  const questions = readQuestions(item.input);
  const [states, setStates] = useState<QuestionState[]>(() => layout.draft.states ?? questions.map(emptyQuestionState));
  const [page, setCurrentPage] = useState(layout.draft.page);
  const setPage = (next: number) => { layout.draft.page = next; setCurrentPage(next); };
  const { busy, error, run } = useBusy();
  const q = questions[page];
  const last = page === questions.length - 1;
  const locked = !!busy || layout.offline;
  const state = states[page] ?? emptyQuestionState();
  const update = (next: QuestionState) => {
    const result = states.map((old, i) => i === page ? next : old);
    layout.draft.states = result;
    setStates(result);
  };
  const ready = q && (last ? isAnswered(questions, states) : isAnswered([q], [state]));
  const advance = () => {
    Keyboard.dismiss();
    if (last) run("send", () => actions.answer(item.id, answersOf(questions, states)));
    else setPage(page + 1);
  };
  const backOrSkip = () => {
    Keyboard.dismiss();
    if (page > 0) setPage(page - 1);
    else run("skip", () => actions.answer(item.id, null));
  };
  const label = [questions.length > 1 ? `Question ${page + 1} of ${questions.length}` : "Question", q?.header].filter(Boolean).join(" · ");
  const question = q?.question ?? "Review this question on your Mac.";
  const backTitle = page > 0 ? "Back" : "Skip";
  return (
    <RequestDock {...layout} step={page} label={label} summary={question} questionTitle={question} progressLabel={questions.length > 1 ? `${page + 1}/${questions.length} ` : undefined} busy={!!busy} footer={<>
      {error && <Text variant="secondary" color="danger" accessibilityLiveRegion="polite">{error}</Text>}
      <View style={styles.replyBar}>
        <Button title={backTitle} kind="plain" style={styles.shortSecondary} busy={busy === "skip"} disabled={locked} onPress={backOrSkip} />
        {q && <TextInput disableFullscreenUI key={page} value={state.text} accessibilityLabel="Your own answer" onChangeText={(text) => update({ picked: q.multiSelect ? state.picked : [], text, other: !!text.trim() })} editable={!busy} placeholder="Your answer" placeholderTextColor={colors.textMuted} maxFontSizeMultiplier={1.25} multiline={!layout.short || Platform.OS === "ios"} style={[styles.answerInput, styles.replyInput, layout.short && styles.shortInput, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]} />}
        {q && <Button title={last ? "Send answer" : "Next"} icon={last ? "arrow.up" : "arrow.right"} style={styles.answerSend} kind="primary" disabled={locked || !ready} busy={busy === "send"} onPress={advance} />}
      </View>
    </>}>
      {q?.multiSelect && !layout.short && <Text variant="caption" color="textMuted">Select all that apply</Text>}
      {q?.options.map((option, i) => {
        const selected = state.picked.includes(option.label);
        const icon = q.multiSelect ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle");
        return <Pressable key={i} accessibilityRole={q.multiSelect ? "checkbox" : "radio"} accessibilityState={{ checked: selected, disabled: !!busy }} disabled={!!busy}
          onPress={() => { update(togglePick(q, state, option.label)); Keyboard.dismiss(); }}
          style={({ pressed }) => [styles.option, { backgroundColor: selected ? withAlpha(colors.accent, 0.1) : pressed ? colors.pressed : colors.surface }]}>
          <Icon name={icon} size={20} color={selected ? "accentText" : "textSubtle"} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="bodyStrong" color="textStrong" maxFontSizeMultiplier={1.25} style={{ fontSize: 15, lineHeight: 20, fontWeight: "500" }}>{option.label}</Text>
            {!!option.description && <Text variant="secondary" color="textMuted" numberOfLines={2} maxFontSizeMultiplier={18 / 13} style={{ fontSize: 13, lineHeight: 18 }}>{option.description}</Text>}
          </View>
        </Pressable>;
      })}
    </RequestDock>
  );
});

export const PlanCard = memo(function PlanCard({ item, actions, ...layout }: DockLayout & { item: PermissionItem; actions: Actions }) {
  const colors = useColors();
  const { busy, error, run } = useBusy();
  const [feedback, setLocalFeedback] = useState(layout.draft.feedback);
  const setFeedback = (value: string | null) => { layout.draft.feedback = value; setLocalFeedback(value); };
  const plan = planText(item.input);
  const locked = !!busy || layout.offline;
  const cancel = () => { Keyboard.dismiss(); setFeedback(null); };
  const keepPlanning = () => {
    Keyboard.dismiss();
    const text = feedback?.trim();
    run("keep", () => actions.plan(item.id, { approve: false, ...(text ? { feedback: text } : {}) }));
  };
  return (
    <RequestDock {...layout} label="Plan" summary="Plan ready for review" busy={!!busy} footer={<>
      {error && <Text variant="secondary" color="danger">{error}</Text>}
      {feedback === null ? <View style={[styles.controls, layout.short && styles.actions]}>
        <Button title="Approve and edit automatically" kind="primary" style={layout.short && styles.widePrimary} busy={busy === "auto"} disabled={locked} onPress={() => run("auto", () => actions.plan(item.id, { approve: true, mode: "acceptEdits" }))} />
        <Button title="Approve, ask before each edit" flex={layout.short} busy={busy === "ask"} disabled={locked} onPress={() => run("ask", () => actions.plan(item.id, { approve: true, mode: "default" }))} />
        <Button title="Keep planning" kind="plain" flex={layout.short} disabled={locked} onPress={() => setFeedback("")} />
      </View> : <View style={[styles.controls, layout.short && styles.actions]}>
        {layout.short && <Button title="Cancel" kind="plain" style={styles.shortSecondary} disabled={!!busy} onPress={cancel} />}
        <TextInput disableFullscreenUI autoFocus value={feedback} onChangeText={setFeedback} accessibilityLabel="Plan feedback" placeholder="What should change in the plan?" placeholderTextColor={colors.textMuted} multiline={!layout.short || Platform.OS === "ios"} style={[styles.answerInput, layout.short && styles.shortInput, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]} />
        <View style={styles.actions}>
          {!layout.short && <Button title="Cancel" flex disabled={!!busy} onPress={cancel} />}
          <Button title="Send" kind="primary" style={layout.short ? styles.shortPrimary : styles.widePrimary} disabled={locked} busy={busy === "keep"} onPress={keepPlanning} />
        </View>
      </View>}
    </>}>
      {plan ? <MarkdownView text={plan} /> : <Text color="textMuted">The plan is on your Mac.</Text>}
    </RequestDock>
  );
});

export const AnsweredRow = memo(function AnsweredRow({ item }: { item: PermissionItem }) {
  const colors = useColors();
  const answers = item.outcome?.answers ?? {};
  const questions = readQuestions(item.input);
  const entries = questions.length > 0
    ? questions.filter(q => !!answers[q.question]).map(q => [q.question, answers[q.question]])
    : Object.entries(answers);
  return <View style={{ alignItems: "flex-end", gap: spacing.sm }}>
    {entries.map(([question, answer], i) => <View key={i} style={[styles.answered, { backgroundColor: colors.userBubble }]}>
      <Text variant="caption" color="textMuted" selectable>{question}</Text>
      <Text color="textStrong" style={{ fontWeight: "500" }} selectable>{answer}</Text>
    </View>)}
  </View>;
});

const styles = StyleSheet.create({
  code: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingVertical: 10 },
  controls: { gap: spacing.sm },
  actions: { flexDirection: "row", gap: spacing.sm },
  widePrimary: { flex: 2 },
  shortSecondary: { minWidth: 48, paddingHorizontal: spacing.xs },
  shortPrimary: { minWidth: 96 },
  replyBar: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  answerSend: { width: 36, height: 36, minHeight: 36 },
  replyInput: { flex: 1, minWidth: 0, minHeight: 40 },
  shortInput: { flex: 1, minWidth: 0, minHeight: 48, maxHeight: 48, paddingHorizontal: spacing.md },
  option: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 40, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.sm },
  answerInput: { minHeight: MIN_TOUCH, maxHeight: 90, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: 24, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, textAlignVertical: "center" },
  answered: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
});
