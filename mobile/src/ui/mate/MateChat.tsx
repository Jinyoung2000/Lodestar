import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Keyboard, Modal, Pressable, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import type { AssistantAction, AssistantApproval, AssistantState } from "@shared/assistant";
import type { FollowUpItem } from "@shared/followups";
import { clockText, mateActionView, mateFeed, reviewFollowUpLabel, SNOOZE_CHOICES, type MateEntry } from "../../logic/mateCore.generated";
import type { Agent, EffortLevel, Harness } from "@shared/protocol";
import { ageText, itemText } from "../../logic/mate";
import { PLAN_TOOL, QUESTION_TOOL } from "../../logic/questions";
import { type PermissionItem, needsDesktopReview } from "../../logic/timeline";
import { requestDraft, sessionViewState } from "../../state/sessionView";
import { store, useAppState } from "../../state/app";
import { MIN_TOUCH, radius, spacing, useColors } from "../../theme/theme";
import { showActionMenu } from "../actionMenu";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { ApprovalCard, PlanCard, QuestionCard, type Actions } from "../chat/Cards";
import { PreviewModal, usePreview } from "../Preview";
import { ToolbarButton } from "../ToolbarButton";
import { KeyboardSpacer, useKeyboardTop } from "../KeyboardSpacer";
import { MarkdownView } from "../MarkdownView";
import { ModelSubtitle, modelPickerLabel } from "../ModelPicker";
import { ProviderMark, PROVIDER_NAMES } from "../ProviderMark";
import { Text } from "../Text";

const NO_ITEMS: never[] = [];
const report = (error: unknown) => Alert.alert("Mate could not do that", error instanceof Error ? error.message : String(error));

type MateModelControl = { harness: Harness; name: string; effort: EffortLevel | null; onPress: () => void };
type MateChatProps = { agent: Agent; assistant: AssistantState; modelControl: MateModelControl };

export function MateChat({ agent, assistant, modelControl }: MateChatProps) {
  const colors = useColors();
  const items = useAppState((s) => s.timelines[agent.id]?.items) ?? NO_ITEMS;
  const open = useAppState((s) => s.followUps?.enabled ? s.followUps.items : NO_ITEMS);
  const entries = useMemo(() => [...mateFeed({ items, checkIns: assistant.checkIns, followUps: open, status: agent.status, now: Date.now(), actions: assistant.actions })].reverse(), [items, assistant.checkIns, open, agent.status, assistant.actions]);
  const [draft, setDraft] = useState("");
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    store.send(agent.id, text).catch((error: unknown) => {
      setDraft((current) => current || text);
      report(error);
    });
  };
  return (
    <View style={styles.fill}>
      <FlatList
        inverted
        data={entries}
        keyExtractor={(entry) => entry.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.feed}
        renderItem={({ item }) => <Entry agentId={agent.id} entry={item} />}
      />
      <View style={[styles.composer, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}>
        <TextInput
          multiline
          accessibilityLabel="Message Mate"
          placeholder="Message Mate"
          placeholderTextColor={colors.textSubtle}
          value={draft}
          onChangeText={setDraft}
          style={[styles.input, { color: colors.textStrong }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${PROVIDER_NAMES[modelControl.harness]}, ${modelPickerLabel(modelControl.name, modelControl.effort)}`}
          hitSlop={4}
          onPress={modelControl.onPress}
          style={({ pressed }) => [styles.model, pressed && { backgroundColor: colors.pressed }]}
        >
          <ProviderMark harness={modelControl.harness} size={18} selected />
          <ModelSubtitle name={modelControl.name} effort={modelControl.effort} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Send to Mate" disabled={!draft.trim()} onPress={send} style={[styles.send, { backgroundColor: draft.trim() ? colors.accent : colors.overlay }]}>
          <Icon name="arrow.up" size={20} color={draft.trim() ? "onAccent" : "textSubtle"} />
        </Pressable>
      </View>
      <KeyboardSpacer />
    </View>
  );
}

type EntryProps = { agentId: string; entry: MateEntry };

function Entry({ agentId, entry }: EntryProps) {
  const colors = useColors();
  switch (entry.kind) {
    case "checkIn":
      return (
        <Text variant="caption" color="textSubtle" style={styles.checkIn}>
          {entry.at ? `Check-in, ${clockText(new Date(entry.at))}` : "Check-in"}
        </Text>
      );
    case "mate":
      return (
        <View style={[styles.bubble, styles.fromMate, { backgroundColor: colors.pressed }]}>
          <MarkdownView text={entry.text} />
        </View>
      );
    case "user":
      return (
        <View style={[styles.bubble, styles.fromUser, { backgroundColor: colors.userBubble }]}>
          <Text color="textStrong" selectable>
            {entry.text}
          </Text>
        </View>
      );
    case "decisions":
      return <DecisionStack items={entry.items} />;
    case "approval":
      if (entry.approval) return <MateApproval agentId={agentId} itemId={entry.id} approval={entry.approval} />;
      return <MateRequest agentId={agentId} item={entry.item} />;
    case "question":
      return <MateRequest agentId={agentId} item={entry.item} />;
    case "working":
      return (
        <Text variant="secondary" color="textMuted" style={styles.working}>
          Working…
        </Text>
      );
    case "action":
      return <ActionRow action={entry.action} />;
    case "error":
      return (
        <Text variant="secondary" color="danger" style={styles.working}>
          {entry.text}
        </Text>
      );
  }
}

function MateRequest({ agentId, item }: { agentId: string; item: PermissionItem }) {
  const height = useWindowDimensions().height;
  const available = useKeyboardTop() ?? height;
  const offline = useAppState((s) => s.conn !== "online");
  const preview = usePreview(agentId);
  const actions: Actions = {
    allow: (id) => store.respondPermission(agentId, id, "allow"),
    deny: (id) => store.respondPermission(agentId, id, "deny"),
    answer: (id, answers) => store.answerQuestion(agentId, id, answers),
    plan: (id, decision) => store.respondPlan(agentId, id, decision),
  };
  const layout = { draft: requestDraft(sessionViewState(agentId), item.id), limit: available * 0.7, compact: available < 480, short: available < 320, offline, focusOnOpen: false, onOpen: () => {} };
  if (item.toolName === PLAN_TOOL) return <PlanCard {...layout} item={item} actions={actions} />;
  if (item.toolName !== QUESTION_TOOL) return <ApprovalCard {...layout} item={item} actions={actions} tool={null} reviewOnDesktop={needsDesktopReview(item.toolName)} />;
  return <>
    <QuestionCard {...layout} item={item} actions={actions} openPreview={preview.open} />
    {preview.selected && <Modal onRequestClose={preview.close}><PreviewModal {...preview} /></Modal>}
  </>;
}

function MateApproval({ agentId, itemId, approval }: { agentId: string; itemId: string; approval: AssistantApproval }) {
  const colors = useColors();
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const respond = (decision: "allow" | "deny") => {
    if (pending) return;
    setPending(decision);
    void store.respondPermission(agentId, itemId, decision).catch((error: unknown) => { setPending(null); report(error); });
  };
  return (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <Text variant="bodyStrong" color="textStrong">{approval.title}</Text>
      {!!approval.message && <Text color="textStrong" selectable>{approval.message}</Text>}
      <View style={styles.actions}>
        <Button title={approval.confirmLabel} kind="primary" flex disabled={!!pending} busy={pending === "allow"} onPress={() => respond("allow")} />
        <Button title="Cancel" kind="plain" disabled={!!pending} busy={pending === "deny"} onPress={() => respond("deny")} />
      </View>
    </View>
  );
}

type ActionRowProps = { action: AssistantAction };

function ActionRow({ action }: ActionRowProps) {
  const colors = useColors();
  const agents = useAppState((s) => s.agents);
  const view = useMemo(() => mateActionView(action, agents), [action, agents]);
  const undone = view.state === "undone";
  const undo = () => void store.undoMateAction(action.id).catch(report);
  return (
    <View style={[styles.action, view.state === "blocked" && styles.actionBlocked]}>
      <View style={styles.actionIcon}>
        <Icon name={undone ? "arrow.uturn.backward" : "checkmark"} size={16} color="textMuted" />
      </View>
      <View style={styles.actionMain}>
        <Text variant="secondary" color={undone ? "textMuted" : "text"} numberOfLines={2}>
          {view.parts.map((part, index) =>
            part.strong && !undone ? (
              <Text key={index} variant="secondary" color="textStrong" style={styles.actionName}>
                {part.text}
              </Text>
            ) : (
              part.text
            ),
          )}
        </Text>
        {view.titles && (
          <View style={styles.actionDetail}>
            <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.actionTitles}>
              {view.titles}
            </Text>
            {view.more && (
              <Text variant="caption" color="textMuted" style={styles.actionMore}>
                {view.more}
              </Text>
            )}
          </View>
        )}
        {view.note && (
          <Text variant="caption" color="textMuted" style={styles.actionNote}>
            {view.note}
          </Text>
        )}
      </View>
      {view.state === "open" && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Undo: ${view.label}`} onPress={undo} style={({ pressed }) => [styles.actionTrail, pressed && { backgroundColor: colors.pressed }]}>
          <Text variant="secondary" color="accentText" style={styles.actionName}>
            Undo
          </Text>
        </Pressable>
      )}
      {undone && (
        <View style={styles.actionTrail}>
          <Text variant="secondary" color="textMuted">
            {view.undoneLabel}
          </Text>
        </View>
      )}
    </View>
  );
}

function DecisionStack({ items }: { items: FollowUpItem[] }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const more = items.length - 1;
  return (
    <View style={styles.cards}>
      {(expanded ? items : items.slice(0, 1)).map((item) => <DecisionCard key={item.id} item={item} />)}
      {more > 0 && <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [styles.moreDecisions, pressed && { backgroundColor: colors.pressed }]}>
        <Text variant="secondary" color="textMuted">{expanded ? "Show fewer decisions" : `Show ${more} more ${more === 1 ? "decision" : "decisions"}`}</Text>
        <Icon name={expanded ? "chevron.up" : "chevron.down"} size={16} color="textMuted" />
      </Pressable>}
    </View>
  );
}

const REMIND = { "2h": "Remind me in 2 hours", tomorrow: "Remind me tomorrow morning", nextWeek: "Remind me next week" } as const;

function DecisionCard({ item }: { item: FollowUpItem }) {
  const colors = useColors();
  const router = useRouter();
  const agent = useAppState((s) => s.agents.find((a) => a.id === item.agentId));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  if (!agent) return null;
  const openSession = () => router.push({ pathname: "/session/[id]", params: { id: agent.id, focusQuestion: "1" } });
  const reply = (text: string) => {
    if (!text.trim() || sending !== null) return;
    setSending(text);
    Keyboard.dismiss();
    void store.replyToFollowUp(item.id, text.trim()).catch((error: unknown) => { setSending(null); report(error); });
  };
  const more = () => showActionMenu(agent.title, [
    ...SNOOZE_CHOICES.map((choice) => ({ label: REMIND[choice], onPress: () => void store.snoozeFollowUp(item.id, choice).catch(report) })),
    { label: "Dismiss from Mate", onPress: () => void store.dismissFollowUp(item.id).catch(report) },
  ]);
  const canSend = !!draft.trim() && sending === null;
  return (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <View style={styles.cardHead}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${agent.title}`} onPress={openSession} style={styles.sessionLink}>
          <Text variant="secondary" color="textStrong" numberOfLines={1}>{agent.title}</Text>
          <Text variant="caption" color="textMuted">{`Waiting ${ageText(item.since, Date.now())}`}</Text>
        </Pressable>
        <ToolbarButton icon="ellipsis" label={`More actions for ${agent.title}`} onPress={sending === null ? more : undefined} />
      </View>
      <Text variant="bodyStrong" color="textStrong" selectable>{itemText(item)}</Text>
      {item.kind === "ask" ? (
        <>
          {item.options.length > 0 && <View style={[styles.choices, { borderColor: colors.separator }]}>
            {item.options.map((option, index) => (
              <Pressable key={option} accessibilityRole="button" accessibilityLabel={`Send reply: ${option}`} disabled={sending !== null}
                onPress={() => reply(option)} style={({ pressed }) => [styles.choice, { backgroundColor: pressed ? colors.pressed : colors.surface, borderTopWidth: index ? StyleSheet.hairlineWidth : 0, borderColor: colors.separator }]}>
                <Text style={styles.choiceText} color={sending !== null ? "textMuted" : "textStrong"}>{option}</Text>
                {sending === option ? <ActivityIndicator color={colors.textMuted} /> : <Icon name="arrow.up" size={16} color="textMuted" />}
              </Pressable>
            ))}
          </View>}
          <View style={[styles.replyField, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
            <TextInput value={draft} onChangeText={setDraft} editable={sending === null} accessibilityLabel={`Reply to ${agent.title}`} placeholder="Reply to this session"
              placeholderTextColor={colors.textSubtle} returnKeyType="send" onSubmitEditing={() => reply(draft)} style={[styles.replyInput, { color: colors.textStrong }]} />
            <Pressable accessibilityRole="button" accessibilityLabel={`Send reply to ${agent.title}`} accessibilityState={{ disabled: !canSend }}
              disabled={!canSend} onPress={() => reply(draft)} style={({ pressed }) => [styles.replySend, pressed && { backgroundColor: colors.pressed }]}>
              <Icon name="arrow.up" color={canSend ? "accentText" : "textSubtle"} />
            </Pressable>
          </View>
        </>
      ) : <Button title={reviewFollowUpLabel[item.kind]} onPress={openSession} />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  feed: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.sm },
  checkIn: { alignSelf: "center", marginVertical: spacing.xs },
  bubble: { maxWidth: "88%", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg, marginVertical: spacing.xs },
  fromMate: { alignSelf: "flex-start" },
  fromUser: { alignSelf: "flex-end" },
  cards: { gap: spacing.sm, marginVertical: spacing.xs },
  card: { alignSelf: "flex-start", width: "100%", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderRadius: radius.lg, marginVertical: spacing.xs },
  moreDecisions: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: MIN_TOUCH, paddingHorizontal: spacing.md, borderRadius: radius.md },
  cardHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sessionLink: { flex: 1, minWidth: 0, minHeight: MIN_TOUCH, justifyContent: "center" },
  choices: { overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  choice: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: MIN_TOUCH, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  choiceText: { minWidth: 0, flex: 1 },
  replyField: { flexDirection: "row", alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  replyInput: { flex: 1, minWidth: 0, minHeight: MIN_TOUCH, fontSize: 16, paddingHorizontal: spacing.md },
  replySend: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: "center", alignItems: "center", borderRadius: radius.md },
  actions: { flexDirection: "row", gap: spacing.sm },
  working: { alignSelf: "flex-start", marginVertical: spacing.xs },
  action: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingLeft: spacing.md },
  actionBlocked: { paddingRight: spacing.md },
  actionIcon: { width: 16, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  actionMain: { flex: 1, minWidth: 0, paddingVertical: (MIN_TOUCH - 20) / 2 },
  actionName: { fontWeight: "600" },
  actionDetail: { flexDirection: "row", gap: spacing.xs, minWidth: 0 },
  actionTitles: { flexShrink: 1, minWidth: 0 },
  actionMore: { flexShrink: 0 },
  actionNote: { marginTop: spacing.xs },
  actionTrail: { minHeight: MIN_TOUCH, paddingHorizontal: spacing.md, justifyContent: "center", borderRadius: radius.md },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, marginHorizontal: spacing.md, marginBottom: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.xs, paddingVertical: spacing.xs, borderWidth: 1, borderRadius: 22 },
  input: { flex: 1, minHeight: MIN_TOUCH - spacing.sm, maxHeight: 140, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  model: { flexShrink: 1, maxWidth: 170, height: 36, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.md, marginBottom: 2 },
  send: { width: 36, height: 36, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", marginBottom: 2 },
});
