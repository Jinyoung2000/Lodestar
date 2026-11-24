import * as Updates from "expo-updates";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { hasMixedRoutes, parseConnectionRoutes, routeAddress, routeLabel } from "../logic/routes";
import { relayHost } from "../net/relay";
import type { ConnFailure } from "../net/rpc";
import { activitySupported, alertsEnabled, enableAlerts, stopAlerts } from "../state/activity";
import { client, store, unpair, updateRoutes, useAppState, useConnection } from "../state/app";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "../state/themePrefs";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Button } from "../ui/Button";
import { useReconnect } from "../ui/ConnectionTitle";
import { KeyboardSpacer } from "../ui/KeyboardSpacer";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Text } from "../ui/Text";

const FAILURE_TEXT: Record<ConnFailure, string> = {
  "mac-off-relay": "Your Mac is not on the relay",
  "relay-silent": "No answer through the relay",
  "mac-silent": "No answer from your Mac",
};

const themeOptions: SegmentedOption<ThemeChoice>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "midnight", label: "Midnight" },
];

function appVersionLabel() {
  const { runtimeVersion, isEmbeddedLaunch, updateId } = Updates;
  if (!runtimeVersion) return "Development";
  if (isEmbeddedLaunch) return `${runtimeVersion} · Built in`;
  return `${runtimeVersion} · OTA${updateId ? ` ${updateId.slice(-8)}` : ""}`;
}

export default function Settings() {
  const router = useRouter();
  const colors = useColors();
  const theme = useThemeChoice() ?? "system";
  const { connection } = useConnection();
  const conn = useAppState((s) => s.conn);
  const reconnect = useReconnect();
  const hostName = useAppState((s) => s.hostName);
  const syncedAt = useAppState((s) => s.syncedAt);
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [savingAddresses, setSavingAddresses] = useState(false);

  const [alerts, setAlerts] = useState(alertsEnabled);
  const [changingAlerts, setChangingAlerts] = useState(false);
  const toggleAlerts = async (enabled: boolean) => {
    if (!connection || changingAlerts) return;
    setChangingAlerts(true);
    try {
      if (enabled) await enableAlerts(connection);
      else stopAlerts();
    } catch (error) {
      Alert.alert("Background connection", error instanceof Error ? error.message : String(error), [
        { text: "Close", style: "cancel" },
        { text: "Android settings", onPress: () => void Linking.openSettings() },
      ]);
    } finally {
      setAlerts(alertsEnabled());
      setChangingAlerts(false);
    }
  };

  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      if (!Updates.isEnabled) throw new Error("Install a release build to receive updates.");
      if (!(await Updates.checkForUpdateAsync()).isAvailable) {
        Alert.alert("Up to date", "This device has the latest compatible update.");
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert("Update ready", "Restart Lodestar to use the update.", [
        { text: "Later", style: "cancel" },
        { text: "Restart", onPress: () => void Updates.reloadAsync().catch(() => Alert.alert("Close and reopen Lodestar to update.")) },
      ]);
    } catch (error) {
      Alert.alert("Could not check for updates", error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const addresses = connection?.routes.map(routeAddress).join("\n") ?? "";
  const editAddresses = () => setAddressDraft(addresses);

  const saveAddresses = async () => {
    if (!connection || addressDraft === null || savingAddresses) return;
    const routes = parseConnectionRoutes(addressDraft);
    if (!routes) return Alert.alert("Check the server addresses", "Enter one local address, Tailscale URL, or Cloudflare Quick Tunnel URL per line.");
    setSavingAddresses(true);
    try {
      await updateRoutes(routes);
      setAddressDraft(null);
    } catch (error) {
      Alert.alert("Could not save the addresses", error instanceof Error ? error.message : String(error));
    } finally {
      setSavingAddresses(false);
    }
  };

  const clearSaved = async () => {
    await store.reset();
    store.attach(client);
    if (client.status === "online") void store.sync();
    else client.resume();
  };

  const disconnect = () => {
    Alert.alert("Disconnect from this Mac?", "This phone forgets the connection and its saved sessions. To block it for good, also remove it in Lodestar Settings on your Mac.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () => {
          void unpair().then(() => router.dismissAll());
        },
      },
    ]);
  };

  const statusText = conn === "online" ? `Connected${client.route ? ` via ${routeLabel(client.route)}` : ""}` : conn === "unauthorized" ? "Removed from your Mac" : conn === "idle" ? "Not connected" : conn === "offline" ? `Offline · ${client.failure ? FAILURE_TEXT[client.failure] : "Retrying"}` : "Reconnecting…";
  return <>
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      <Section title="Appearance">
        <Segmented flush options={themeOptions} value={theme} onChange={setThemeChoice} />
        {theme === "system" && <Text variant="caption" color="textMuted">Follows your phone's setting.</Text>}
      </Section>
      <Section title="Connection">
        {activitySupported && connection && <View style={[styles.row, { alignItems: "center" }]}>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">Keep connected in background</Text>
            <Text variant="caption" color="textMuted">{hasMixedRoutes(connection.routes) ? "Background alerts use HTTPS." : "Includes session alerts."}</Text>
          </View>
          <Switch accessibilityLabel="Keep connected in background" value={alerts} disabled={changingAlerts} trackColor={{ false: colors.border, true: colors.accent }} onValueChange={(value) => void toggleAlerts(value)} />
        </View>}
        <Row label="Mac" value={hostName ?? connection?.hostName ?? "-"} />
        <Row label="Status" value={statusText} valueColor={conn === "online" ? "success" : conn === "unauthorized" ? "danger" : "warning"} />
        {addressDraft === null && <Row label="Addresses" value={addresses || "-"} />}
        {connection?.relay && <Row label="Relay" value={relayHost(connection.relay)} singleLine />}
        <Row label="Last sync" value={syncedAt ? new Date(syncedAt).toLocaleTimeString() : "-"} />
        <Button title={conn === "unauthorized" ? "Pair again" : "Reconnect"} onPress={reconnect} />
        {connection && (addressDraft === null ? (
          <>
            <View style={styles.buttons}>
              <Button title="Scan new code" kind="plain" onPress={() => router.push("/scan")} style={styles.actionButton} />
              <Button title="Edit addresses" kind="plain" onPress={editAddresses} style={styles.actionButton} />
            </View>
          </>
        ) : (
          <View style={{ gap: spacing.sm }}>
            <Text variant="caption" color="textSubtle">Enter one address per line, in the order you want to try them.</Text>
            <TextInput
              disableFullscreenUI
              multiline
              value={addressDraft}
              onChangeText={setAddressDraft}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              editable={!savingAddresses}
              accessibilityLabel="Mac addresses"
              style={[styles.input, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}
            />
            <View style={styles.buttons}>
              <Button title="Cancel" disabled={savingAddresses} onPress={() => setAddressDraft(null)} style={styles.actionButton} />
              <Button title="Save" kind="primary" busy={savingAddresses} onPress={saveAddresses} style={styles.actionButton} />
            </View>
          </View>
        ))}
      </Section>
      <Section title="App updates">
        <Row label="Version" value={appVersionLabel()} />
        <Button title="Check for update" busy={checkingUpdate} onPress={() => void checkUpdate()} />
      </Section>
      <View style={{ gap: spacing.xs }}>
        <Button title="Clear saved sessions" kind="plain" onPress={() => void clearSaved()} />
        <Button title="Disconnect from this Mac" kind="danger" onPress={disconnect} />
      </View>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={{ minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center" }}>
        <Text color="accentText">Done</Text>
      </Pressable>
    </ScrollView>
    {Platform.OS === "android" && <KeyboardSpacer />}
  </>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="caption" color="textMuted" style={styles.sectionTitle}>{title}</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>{children}</View>
    </View>
  );
}

function Row({ label, value, valueColor = "textStrong", singleLine = false }: { label: string; value: string; valueColor?: "textStrong" | "success" | "danger" | "warning"; singleLine?: boolean }) {
  return (
    <View style={styles.row}>
      <Text variant="secondary" color="textMuted" style={{ width: 88 }}>{label}</Text>
      <Text variant="secondary" color={valueColor} selectable numberOfLines={singleLine ? 1 : undefined} adjustsFontSizeToFit={singleLine} minimumFontScale={0.75} style={{ flex: 1, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  sectionTitle: { fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, paddingHorizontal: spacing.xs },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, minHeight: 20 },
  input: { minHeight: 88, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, fontSize: 16, textAlignVertical: "top" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  actionButton: { flexGrow: 1, paddingHorizontal: spacing.sm },
});
