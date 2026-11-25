import { Redirect, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, BackHandler, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { openDecisionCount } from "../logic/mateCore.generated";
import { mateStatus } from "../logic/mate";
import { store, useAppState } from "../state/app";
import { MIN_TOUCH, spacing, useColors } from "../theme/theme";
import { Icon } from "../ui/Icon";
import { MateChat } from "../ui/mate/MateChat";
import { MateReminders, MateTracking } from "../ui/mate/MateLists";
import { MateAvatar } from "../ui/mate/MateRow";
import { ModelPicker, useModelPicker } from "../ui/ModelPicker";
import { Segmented } from "../ui/Segmented";
import { Text } from "../ui/Text";

type Tab = "chat" | "tracking" | "reminders";

export default function Mate() {
  const colors = useColors();
  const assistant = useAppState((s) => s.assistant);
  const agents = useAppState((s) => s.agents);
  const items = useAppState((s) => s.followUps?.items);
  const loaded = useAppState((s) => s.loaded);
  const [tab, setTab] = useState<Tab>("chat");
  const agentId = assistant?.agentId ?? null;
  const agent = agents.find((a) => a.id === agentId);
  const model = useModelPicker(agent);
  const { open: modelOpen, close: closeModel } = model;

  useEffect(() => {
    if (!modelOpen) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      closeModel();
      return true;
    });
    return () => back.remove();
  }, [modelOpen, closeModel]);

  useEffect(() => {
    if (!agentId) return;
    void store.openSession(agentId);
    return () => store.closeSession(agentId);
  }, [agentId]);

  if (loaded && (!assistant || !agent)) return <Redirect href="/" />;
  if (!assistant || !agent) return <View style={styles.fill} />;
  const now = Date.now();
  const waiting = items ? openDecisionCount(agents, items, now) : 0;
  const busy = assistant.busy || agent.status === "running" || agent.status === "waiting";
  const checkIn = () => void store.checkInMate().catch((error: unknown) => Alert.alert("Mate could not check in", error instanceof Error ? error.message : String(error)));
  return (
    <SafeAreaView edges={["bottom"]} style={[styles.fill, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: "",
          headerShown: !modelOpen,
          gestureEnabled: !modelOpen,
          headerBackButtonDisplayMode: "minimal",
          headerTitleAlign: "center",
          headerTitle: () => (
            <View style={styles.identity}>
              <MateAvatar size={28} busy={busy} />
              <View style={styles.identityText}>
                <Text accessibilityRole="header" variant="bodyStrong" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.1}>
                  {agent.title}
                </Text>
                <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.1}>
                  {mateStatus(agent, assistant, now)}
                </Text>
              </View>
            </View>
          ),
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Check in now" disabled={busy} onPress={checkIn} style={styles.headerButton}>
              <Icon name="arrow.clockwise" size={20} color={busy ? "textSubtle" : "textStrong"} />
            </Pressable>
          ),
        }}
      />
      <Segmented underline options={[{ value: "chat", label: "Chat" }, { value: "tracking", label: "Tracking", count: waiting, countTone: "attention" }, { value: "reminders", label: "Reminders" }]} value={tab} onChange={setTab} />
      {tab === "chat" ? <MateChat agent={agent} assistant={assistant} modelControl={{ harness: model.selection.harness, name: model.name, effort: model.effort, onPress: model.show }} /> : tab === "tracking" ? <MateTracking /> : <MateReminders assistant={assistant} />}
      {modelOpen && <ModelPicker agentId={agent.id} selection={model.selection} close={closeModel} apply={(selection) => store.setModel(agent.id, selection)} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  identity: { flexDirection: "row", alignItems: "center", gap: spacing.sm, maxWidth: 240 },
  identityText: { flexShrink: 1 },
  headerButton: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
});
