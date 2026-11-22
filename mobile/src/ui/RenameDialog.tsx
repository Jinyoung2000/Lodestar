import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Text } from "./Text";

export function RenameDialog({ initial, onSubmit, onClose }: { initial: string | null; onSubmit: (title: string) => Promise<void>; onClose: () => void }) {
  const colors = useColors();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (initial !== null) {
      setText(initial);
      setError(null);
      setBusy(false);
    }
  }, [initial]);
  const title = text.replace(/\s+/g, " ").trim();
  const save = async () => {
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(title);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal visible={initial !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
        <Pressable accessibilityLabel="Dismiss" style={[styles.fill, styles.scrim]} onPress={onClose}>
          <Pressable accessible={false} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text variant="title" color="textStrong">Rename session</Text>
            <TextInput
              accessibilityLabel="Session name"
              value={text}
              onChangeText={setText}
              autoFocus
              selectTextOnFocus
              maxLength={200}
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              placeholderTextColor={colors.textSubtle}
              style={[styles.input, { color: colors.textStrong, borderColor: colors.border, backgroundColor: colors.background }]}
            />
            {error && <Text variant="secondary" color="danger">{error}</Text>}
            <View style={styles.buttons}>
              <Button title="Cancel" onPress={onClose} flex />
              <Button title="Save" kind="primary" onPress={() => void save()} disabled={!title} busy={busy} flex />
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "flex-start", paddingTop: "22%", paddingHorizontal: spacing.lg },
  card: { width: "100%", maxWidth: 420, gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, fontSize: 16 },
  buttons: { flexDirection: "row", gap: spacing.sm },
});
