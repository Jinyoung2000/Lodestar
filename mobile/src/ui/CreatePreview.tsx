import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Text } from "./Text";

const formats = [
  { label: "Prototype", fence: "lodestar-preview", request: "a self-contained interactive HTML prototype with inline styles and scripts" },
  { label: "Diagram", fence: "svg", request: "a self-contained, legible SVG diagram with a viewBox" },
  { label: "Document", fence: "markdown", request: "a formatted Markdown document" },
  { label: "Table", fence: "csv", request: "a CSV table with a header row" },
];

export function CreatePreview({ close, send }: { close: () => void; send: (prompt: string) => Promise<unknown> }) {
  const colors = useColors();
  const [format, choose] = useState(formats[0]);
  const [request, change] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!request.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await send(`${request.trim()}\n\nCreate ${format.request} for Lodestar Preview. Put the result in a fenced code block with an opening line of three backticks followed by "${format.fence} Your descriptive title". Embed all assets in the document.`);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send this request.");
      setBusy(false);
    }
  };
  return <Modal visible animationType="slide" onRequestClose={() => { if (!busy) close(); }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.lg, padding: spacing.lg, width: "100%", maxWidth: 640, alignSelf: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text variant="largeTitle" color="textStrong" style={{ flex: 1 }}>New preview</Text>
          <Button title="Cancel" kind="plain" disabled={busy} onPress={close} />
        </View>
        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          {formats.map((f) => <Pressable key={f.label} accessibilityRole="radio" accessibilityState={{ checked: format === f }} onPress={() => choose(f)} style={{ minHeight: 44, justifyContent: "center", borderRadius: radius.md, paddingHorizontal: spacing.md, backgroundColor: format === f ? colors.selected : colors.surfaceBase }}>
            <Text variant="secondary" color={format === f ? "textStrong" : "textMuted"}>{f.label}</Text>
          </Pressable>)}
        </View>
        <TextInput disableFullscreenUI multiline value={request} onChangeText={change} accessibilityLabel="Preview request" placeholder="What would you like to see?" placeholderTextColor={colors.textMuted} textAlignVertical="top" autoFocus style={{ minHeight: 132, fontSize: 16, padding: spacing.md, borderRadius: radius.md, color: colors.textStrong, backgroundColor: colors.inputBackground }} />
        {!!error && <Text variant="secondary" color="danger">{error}</Text>}
        <Button title="Send to session" kind="primary" busy={busy} disabled={!request.trim()} onPress={() => void submit()} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
