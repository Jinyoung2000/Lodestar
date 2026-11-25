import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import type { AssistantAction, AssistantState } from "@shared/assistant";
import type { FollowUpItem } from "@shared/followups";
import { clockText, mateActionView, mateFeed, SNOOZE_CHOICES, type MateEntry } from "../../logic/mateCore.generated";
import type { Agent, EffortLevel, Harness } from "@shared/protocol";
import { ageText, itemText, SNOOZE_LABEL } from "../../logic/mate";
import { store, useAppState } from "../../state/app";
import { MIN_TOUCH, radius, spacing, useColors } from "../../theme/theme";
import { showActionMenu } from "../actionMenu";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { KeyboardSpacer } from "../KeyboardSpacer";
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
  const open = useAppState((s) => s.followUps?.items) ?? NO_ITEMS;
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
        <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!draft.trim()} onPress={send} style={[styles.send, { backgroundColor: draft.trim() ? colors.accent : colors.overlay }]}>
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
      return (
        <View style={styles.cards}>
          {entry.items.map((item) => (
            <DecisionCard key={item.id} item={item} />
          ))}
        </View>
      );
    case "approval": {
      const respond = (decision: "allow" | "deny") => void store.respondPermission(agentId, entry.item.id, decision).catch(report);
      const command = typeof entry.item.input.command === "string" ? entry.item.input.command : "";
      return (
        <View style={[styles.card, { borderColor: colors.border }]}>
          <Text variant="bodyStrong" color="textStrong">
            {entry.approval?.title ?? `Allow ${entry.item.toolName}?`}
          </Text>
          {(entry.approval?.message || command) !== "" && <Text color="textStrong">{entry.approval?.message || command}</Text>}
          <View style={styles.actions}>
            <Button title="Allow" kind="primary" flex onPress={() => respond("allow")} />
            <Button title="Skip" flex onPress={() => respond("deny")} />
          </View>
        </View>
      );
    }
    case "question":
      return (
        <View style={[styles.card, { borderColor: colors.border }]}>
          <Text color="textStrong">Mate is asking you something. Answer it on your Mac.</Text>
        </View>
      );
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

type DecisionCardProps = { item: FollowUpItem };

function DecisionCard({ item }: DecisionCardProps) {
  const colors = useColors();
  const router = useRouter();
  const agent = useAppState((s) => s.agents.find((a) => a.id === item.agentId));
  const workspace = useAppState((s) => s.workspaces.find((w) => w.id === agent?.workspaceId)?.name ?? "");
  const [sending, setSending] = useState<string | null>(null);
  if (!agent) return null;
  const openSession = () => router.push({ pathname: "/session/[id]", params: { id: agent.id } });
  const choose = (option: string) => {
    if (item.kind !== "ask") return openSession();
    if (sending) return;
    setSending(option);
    store
      .send(agent.id, option)
      .catch(report)
      .finally(() => setSending(null));
  };
  const later = () => showActionMenu("Remind me", SNOOZE_CHOICES.map((choice) => ({ label: SNOOZE_LABEL[choice], onPress: () => void store.snoozeFollowUp(item.id, choice).catch(report) })));
  return (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${agent.title}`} onPress={openSession} hitSlop={8}>
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {[agent.title, workspace, `waiting ${ageText(item.since, Date.now())}`].filter(Boolean).join(", ")}
        </Text>
      </Pressable>
      <Text color="textStrong">{itemText(item)}</Text>
      <View style={styles.choices}>
        {item.options.map((option) => (
          <Button key={option} title={option} busy={sending === option} disabled={sending !== null} onPress={() => choose(option)} />
        ))}
        {item.options.length === 0 && <Button title="Open session" onPress={openSession} />}
      </View>
      <View style={styles.footer}>
        <Pressable accessibilityRole="button" onPress={later} hitSlop={10} style={styles.footerAction}>
          <Text variant="secondary" color="textMuted">
            Later
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => void store.dismissFollowUp(item.id).catch(report)} hitSlop={10} style={styles.footerAction}>
          <Text variant="secondary" color="textMuted">
            Not needed
          </Text>
        </Pressable>
      </View>
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
  card: { alignSelf: "flex-start", width: "94%", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderRadius: radius.lg, marginVertical: spacing.xs },
  choices: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  actions: { flexDirection: "row", gap: spacing.sm },
  footer: { flexDirection: "row", gap: spacing.xl },
  footerAction: { minHeight: 32, justifyContent: "center" },
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
