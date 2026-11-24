import { useRouter } from "expo-router";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { AssistantState } from "@shared/assistant";
import type { FollowUpItem } from "@shared/followups";
import { followUpSections, isSnoozed, lastActiveAt } from "../../logic/mateCore.generated";
import type { Agent } from "@shared/protocol";
import { ageText, itemText, KIND_LABEL, whenText } from "../../logic/mate";
import { store, useAppState } from "../../state/app";
import { spacing, useColors } from "../../theme/theme";
import { Button } from "../Button";
import { Text } from "../Text";

const NOTHING = { items: [], notes: [] };
const report = (error: unknown) => Alert.alert("That did not work", error instanceof Error ? error.message : String(error));

export function MateTracking() {
  const colors = useColors();
  const router = useRouter();
  const agents = useAppState((s) => s.agents);
  const followUps = useAppState((s) => s.followUps);
  const now = Date.now();
  const sections = followUpSections(agents, followUps ?? NOTHING, now);
  const open = (agent: Agent) => router.push({ pathname: "/session/[id]", params: { id: agent.id } });
  const nothing = sections.decisions.length === 0 && sections.progress.length === 0 && sections.finished.length === 0;
  const line = { borderTopColor: colors.separator };
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {nothing && <Empty text="Nothing is waiting on you" />}
      {sections.decisions.length > 0 && <Heading title="Needs a decision" count={sections.decisions.filter((row) => !row.snoozed).length} />}
      {sections.decisions.map(({ item, agent, snoozed }) => (
        <Pressable key={item.id} accessibilityRole="button" onPress={() => open(agent)} style={({ pressed }) => [styles.row, line, pressed && { backgroundColor: colors.pressed }]}>
          <Text variant={snoozed ? "body" : "bodyStrong"} color={snoozed ? "textMuted" : "textStrong"}>
            {itemText(item)}
          </Text>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            <Text variant="caption" color={snoozed ? "textMuted" : "warning"}>
              {KIND_LABEL[item.kind]}
            </Text>
            {`, ${snoozed && item.snoozedUntil ? `snoozed until ${whenText(item.snoozedUntil)}` : `waiting ${ageText(item.since, now)}`}, ${agent.title}`}
          </Text>
        </Pressable>
      ))}
      {sections.progress.length > 0 && <Heading title="In progress" count={sections.progress.length} />}
      {sections.progress.map(({ agent, phase, text }) => (
        <Pressable key={agent.id} accessibilityRole="button" onPress={() => open(agent)} style={({ pressed }) => [styles.row, line, pressed && { backgroundColor: colors.pressed }]}>
          <View style={styles.titleLine}>
            <Text color="textStrong" numberOfLines={1} style={styles.grow}>
              {agent.title}
            </Text>
            <Text variant="caption" color={phase === "working" ? "running" : phase === "error" ? "danger" : "textMuted"}>
              {phase === "working" ? "Working" : phase === "error" ? "Stopped on an error" : `Paused ${ageText(new Date(lastActiveAt(agent)).toISOString(), now)}`}
            </Text>
          </View>
          {text !== "" && (
            <Text variant="secondary" color="textMuted">
              {text}
            </Text>
          )}
        </Pressable>
      ))}
      {sections.finished.length > 0 && <Heading title="Looks finished" count={sections.finished.length} />}
      {sections.finished.map(({ agent, text }) => (
        <View key={agent.id} style={[styles.row, styles.finished, line]}>
          <Pressable accessibilityRole="button" onPress={() => open(agent)} style={styles.grow}>
            <Text color="textStrong" numberOfLines={1}>
              {agent.title}
            </Text>
            {text !== "" && (
              <Text variant="secondary" color="textMuted">
                {text}
              </Text>
            )}
          </Pressable>
          <Button title="Mark done" onPress={() => void store.setDone(agent.id, true).catch(report)} />
        </View>
      ))}
    </ScrollView>
  );
}

type MateRemindersProps = { assistant: AssistantState };

export function MateReminders({ assistant }: MateRemindersProps) {
  const colors = useColors();
  const agents = useAppState((s) => s.agents);
  const items = useAppState((s) => s.followUps?.items);
  const now = Date.now();
  const snoozed: FollowUpItem[] = (items ?? []).filter((item) => isSnoozed(item, now));
  const line = { borderTopColor: colors.separator };
  if (assistant.reminders.length === 0 && snoozed.length === 0) return <Empty text="No reminders are set" />;
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {assistant.reminders.map((reminder) => (
        <View key={reminder.id} style={[styles.row, styles.finished, line]}>
          <View style={styles.grow}>
            <Text color="textStrong">{reminder.text}</Text>
            <Text variant="caption" color="textMuted">{`${whenText(reminder.at)}, set by Mate`}</Text>
          </View>
          <Button title="Cancel" kind="plain" onPress={() => void store.cancelMateReminder(reminder.id).catch(report)} />
        </View>
      ))}
      {snoozed.map((item) => (
        <View key={item.id} style={[styles.row, line]}>
          <Text color="textStrong">{itemText(item)}</Text>
          <Text variant="caption" color="textMuted">{`${item.snoozedUntil ? whenText(item.snoozedUntil) : ""}, ${agents.find((a) => a.id === item.agentId)?.title ?? "Snoozed decision"}`}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

type HeadingProps = { title: string; count: number };

function Heading({ title, count }: HeadingProps) {
  return (
    <Text accessibilityRole="header" variant="caption" color="textMuted" style={styles.heading}>
      {`${title} ${count}`}
    </Text>
  );
}

type EmptyProps = { text: string };

function Empty({ text }: EmptyProps) {
  return (
    <Text variant="secondary" color="textMuted" style={styles.empty}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: spacing.xxl },
  heading: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm, fontWeight: "600" },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 2, borderTopWidth: StyleSheet.hairlineWidth },
  finished: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  titleLine: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  grow: { flex: 1, minWidth: 0 },
  empty: { textAlign: "center", paddingTop: spacing.xxl * 2, paddingHorizontal: spacing.lg },
});
