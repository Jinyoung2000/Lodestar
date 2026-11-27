import { Redirect, Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, BackHandler, StyleSheet, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { openDecisionCount } from "../logic/mateCore.generated";
import { store, useAppState } from "../state/app";
import { spacing, useColors } from "../theme/theme";
import { showActionMenu } from "../ui/actionMenu";
import { ConnectionTitle } from "../ui/ConnectionTitle";
import { MateChat } from "../ui/mate/MateChat";
import { MateReminders, MateTracking } from "../ui/mate/MateLists";
import { ModelPicker, useModelPicker } from "../ui/ModelPicker";
import { Text } from "../ui/Text";
import { ToolbarButton } from "../ui/ToolbarButton";

type Panel = "tracking" | "reminders";

const PANEL_TITLE: Record<Panel, string> = { tracking: "Tracking", reminders: "Reminders" };

export default function Mate() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const assistant = useAppState((s) => s.assistant);
  const agents = useAppState((s) => s.agents);
  const items = useAppState((s) => s.followUps?.items);
  const loaded = useAppState((s) => s.loaded);
  const [panel, setPanel] = useState<Panel | null>(null);
  const agentId = assistant?.agentId ?? null;
  const agent = agents.find((a) => a.id === agentId);
  const model = useModelPicker(agent);
  const { open: modelOpen, close: closeModel } = model;

  useEffect(() => {
    if (!modelOpen && !panel) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (modelOpen) closeModel();
      else setPanel(null);
      return true;
    });
    return () => back.remove();
  }, [modelOpen, panel, closeModel]);

  useEffect(() => {
    if (!agentId) return;
    void store.openSession(agentId);
    return () => store.closeSession(agentId);
  }, [agentId]);

  if (loaded && (!assistant || !agent)) return <Redirect href="/" />;
  if (!assistant || !agent) return <View style={styles.fill} />;
  const waiting = items ? openDecisionCount(agents, items, Date.now()) : 0;
  const busy = assistant.busy || agent.status === "running" || agent.status === "waiting";
  const checkIn = () => void store.checkInMate().catch((error: unknown) => Alert.alert("Mate could not check in", error instanceof Error ? error.message : String(error)));
  const title = panel ? PANEL_TITLE[panel] : agent.title;
  return (
    <SafeAreaView edges={["bottom"]} style={[styles.fill, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !modelOpen && !panel }} />
      <View style={styles.fill} pointerEvents={modelOpen ? "none" : "auto"} accessibilityElementsHidden={modelOpen} importantForAccessibility={modelOpen ? "no-hide-descendants" : "auto"}>
        <View style={[styles.bar, { paddingTop: insets.top, paddingLeft: insets.left + spacing.xs, paddingRight: insets.right + spacing.xs }]}>
          {panel
            ? <ToolbarButton icon="chevron.left" label={`Close ${PANEL_TITLE[panel].toLowerCase()}`} onPress={() => setPanel(null)} />
            : <ToolbarButton icon="chevron.left" label="Back" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} />}
          <ConnectionTitle title={title} hidden={modelOpen} style={styles.title}>
            <Text accessibilityRole="header" style={styles.titleText} color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.2}>{title}</Text>
          </ConnectionTitle>
          {!panel && <>
            <ToolbarButton icon="list.bullet.clipboard" label={waiting ? `Tracking, ${waiting} waiting on you` : "Tracking"} badge={waiting || undefined} onPress={() => setPanel("tracking")} />
            <ToolbarButton icon="bell" label="Reminders" onPress={() => setPanel("reminders")} />
            <ToolbarButton icon="ellipsis" label="Mate actions" onPress={busy ? undefined : () => showActionMenu(agent.title, [{ label: "Check in now", onPress: checkIn }])} />
          </>}
        </View>
        <View style={styles.fill}>
          <View style={styles.fill} accessibilityElementsHidden={!!panel} importantForAccessibility={panel ? "no-hide-descendants" : "auto"} pointerEvents={panel ? "none" : "auto"}>
            <MateChat agent={agent} assistant={assistant} modelControl={{ harness: model.selection.harness, name: model.name, effort: model.effort, onPress: model.show }} />
          </View>
          {panel && <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} onAccessibilityEscape={() => setPanel(null)}>
            {panel === "tracking" ? <MateTracking /> : <MateReminders assistant={assistant} />}
          </View>}
        </View>
      </View>
      {modelOpen && <ModelPicker agentId={agent.id} selection={model.selection} close={closeModel} apply={(selection) => store.setModel(agent.id, selection)} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { minHeight: 48, flexDirection: "row", gap: spacing.xs, alignItems: "center" },
  title: { flex: 1, minWidth: 0 },
  titleText: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
});
