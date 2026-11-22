import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { normalizeCode, parseFields, parsePairing, type PairingInfo } from "../logic/pairing";
import { pairAndConnect, useAppState, useConnection } from "../state/app";
import { spacing, radius, useColors } from "../theme/theme";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Text } from "../ui/Text";

export default function Connect() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ uri?: string; scanned?: string }>();
  const { connection } = useConnection();
  const conn = useAppState((s) => s.conn);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

  const pair = async (info: PairingInfo) => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await pairAndConnect(info, deviceName());
      if (!outcome.ok) return setError(outcome.message);
      router.replace("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save this connection.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const raw = params.scanned ?? params.uri;
    if (!raw || handled.current === raw) return;
    handled.current = raw;
    const info = parsePairing(raw);
    if (!info) setError("That QR code is not a Lodestar pairing code.");
    else void pair(info);
  }, [params.scanned, params.uri]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const info = parseFields(address, code);
    if (!info) return setError("Enter the address like 192.168.0.5:7789 and the 8-character code from your Mac.");
    void pair(info);
  };

  if (connection && conn !== "unauthorized" && !busy && !params.scanned && !params.uri) return <Redirect href="/" />;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
        <View style={{ gap: spacing.md }}>
          <Image source={require("../../assets/icon.png")} style={{ width: 56, height: 56, borderRadius: radius.lg }} />
          <Text variant="largeTitle" color="textStrong" accessibilityRole="header">Connect to your Mac</Text>
          <Text variant="body" color="textMuted">
            In Lodestar on your Mac, turn on Mobile access in Settings and create a pairing code.
          </Text>
        </View>
        <Button title="Scan QR code" kind="primary" onPress={() => router.push("/scan")} disabled={busy} />
        <View style={styles.divider}>
          <View style={[styles.line, { backgroundColor: colors.separator }]} />
          <Text variant="secondary" color="textSubtle">or enter it by hand</Text>
          <View style={[styles.line, { backgroundColor: colors.separator }]} />
        </View>
        <View style={{ gap: spacing.xs }}>
          <Text variant="secondary" color="textMuted">Server address</Text>
          <Text variant="caption" color="textMuted">Use a Wi-Fi address, a Tailscale IP, or your HTTPS .ts.net URL.</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder="192.168.0.5:7789"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="next"
            accessibilityLabel="Address"
            style={[styles.input, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}
          />
        </View>
        <View style={{ gap: spacing.xs }}>
          <Text variant="secondary" color="textMuted">Pairing code</Text>
          <Text variant="caption" color="textMuted">Enter 8 characters. The hyphen appears automatically.</Text>
          <TextInput
            value={code}
            onChangeText={(value) => {
              const letters = normalizeCode(value).slice(0, 8);
              setCode(letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters);
            }}
            placeholder="ABCD-EFGH"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={submit}
            accessibilityLabel="Pairing code"
            style={[styles.input, { color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, letterSpacing: 2 }]}
          />
        </View>
        <Button title="Connect" onPress={submit} busy={busy} disabled={!address.trim() || !code.trim()} />
        {error && (
          <View style={[styles.error, { borderColor: colors.danger }]}>
            <Icon name="exclamationmark.triangle" size={18} color="danger" />
            <Text variant="secondary" color="danger" style={{ flex: 1 }}>{error}</Text>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function deviceName() {
  return Platform.OS === "android" ? "Android phone" : "iPhone";
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  divider: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  input: { minHeight: 48, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg, fontSize: 17 },
  error: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start", borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
});
