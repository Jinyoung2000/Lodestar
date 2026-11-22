import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { isLocalNetworkHost } from "../logic/pairing";
import { durationLabel } from "../logic/time";
import { allMetrics, subscribeMetrics, type Metric } from "../state/perf";
import { client, store, unpair, updateHosts, useAppState, useConnection } from "../state/app";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Button } from "../ui/Button";
import { Text } from "../ui/Text";

export default function Settings() {
  const router = useRouter();
  const colors = useColors();
  const { connection } = useConnection();
  const conn = useAppState((s) => s.conn);
  const hostName = useAppState((s) => s.hostName);
  const syncedAt = useAppState((s) => s.syncedAt);
  const [rtt, setRtt] = useState<number | null>(null);
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([...allMetrics()]);
  useEffect(() => {
    const off = subscribeMetrics(() => setMetrics([...allMetrics()]));
    return () => void off();
  }, []);

  const measure = async () => {
    const started = Date.now();
    try {
      await client.call("mobile.ping", {}, 3000);
      setRtt(Date.now() - started);
    } catch (e) {
      Alert.alert("No answer", e instanceof Error ? e.message : String(e));
    }
  };

  const editAddress = () => {
    if (connection) setAddressDraft(`${connection.hosts.join(",")} ${connection.port}`);
  };

  const saveAddress = () => {
    if (!connection || addressDraft === null) return;
    const [hostsText, portText] = addressDraft.trim().split(/\s+/);
    const hosts = (hostsText ?? "").split(",").map((h) => h.trim().replace(/:\d+$/, "")).filter(Boolean);
    const port = Number(portText ?? connection.port);
    if (hosts.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535 || !hosts.every(isLocalNetworkHost)) {
      return Alert.alert("That is not an address", "Use your Mac's address on this network, like 192.168.0.5 7789. A .local name works too.");
    }
    void updateHosts(hosts, port);
    setAddressDraft(null);
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

  const statusText = conn === "online" ? `Connected${client.host ? ` via ${client.host}` : ""}` : conn === "unauthorized" ? "Removed from your Mac" : conn === "idle" ? "Not connected" : "Reconnecting…";
  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      <Section title="Connection">
        <Row label="Mac" value={hostName ?? connection?.hostName ?? "-"} />
        <Row label="Status" value={statusText} valueColor={conn === "online" ? "success" : conn === "unauthorized" ? "danger" : "warning"} />
        <Row label="Addresses" value={connection ? `${connection.hosts.join(", ")}:${connection.port}` : "-"} />
        <Row label="Last sync" value={syncedAt ? new Date(syncedAt).toLocaleTimeString() : "-"} />
        <Row label="Round trip" value={rtt === null ? "Tap Measure" : durationLabel(rtt)} />
        <View style={styles.buttons}>
          <Button title="Measure" onPress={() => void measure()} flex disabled={conn !== "online"} />
          <Button title="Reconnect" onPress={() => client.resume()} flex />
        </View>
        {addressDraft === null ? (
          <Button title="Change address" kind="plain" onPress={editAddress} />
        ) : (
          <View style={{ gap: spacing.sm }}>
            <Text variant="caption" color="textSubtle">Use this when your Mac's address changed. Write the address, a space, then the port. Separate several addresses with commas.</Text>
            <TextInput
              value={addressDraft}
              onChangeText={setAddressDraft}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Mac address"
              onSubmitEditing={saveAddress}
              style={[styles.input, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}
            />
            <View style={styles.buttons}>
              <Button title="Cancel" onPress={() => setAddressDraft(null)} flex />
              <Button title="Save" kind="primary" onPress={saveAddress} flex />
            </View>
          </View>
        )}
      </Section>
      <Section title="Diagnostics">
        <Text variant="caption" color="textSubtle">Times measured in this app session. A development build is slower than a release build.</Text>
        {metrics.length === 0 && <Text variant="secondary" color="textMuted">Nothing measured yet.</Text>}
        {[...metrics].reverse().slice(0, 14).map((m, i) => (
          <View key={`${m.at}-${i}`} style={styles.metric}>
            <Text variant="secondary" style={{ flex: 1 }}>{m.name}</Text>
            <Text variant="secondary" color="textStrong">{durationLabel(m.ms)}</Text>
            {m.detail && <Text variant="caption" color="textMuted" numberOfLines={1} style={{ maxWidth: 140 }}>{m.detail}</Text>}
          </View>
        ))}
        <Button title="Clear saved sessions" kind="plain" onPress={() => void clearSaved()} />
      </Section>
      <Button title="Disconnect from this Mac" kind="danger" onPress={disconnect} style={{ marginTop: spacing.lg }} />
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={{ minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center" }}>
        <Text color="accentText">Done</Text>
      </Pressable>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="secondary" color="textMuted" style={{ fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>{children}</View>
    </View>
  );
}

function Row({ label, value, valueColor = "textStrong" }: { label: string; value: string; valueColor?: "textStrong" | "success" | "danger" | "warning" }) {
  return (
    <View style={styles.row}>
      <Text variant="secondary" color="textMuted" style={{ width: 96 }}>{label}</Text>
      <Text variant="secondary" color={valueColor} selectable style={{ flex: 1, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.xl },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing.lg, gap: spacing.md },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, minHeight: 28 },
  input: { minHeight: 48, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg, fontSize: 16 },
  buttons: { flexDirection: "row", gap: spacing.sm },
  metric: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 28 },
});
