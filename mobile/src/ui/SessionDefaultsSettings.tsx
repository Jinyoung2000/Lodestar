import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileCodexDefaults, MobileModel, MobileModelProvider } from "@shared/mobile";
import { fallbackEffort, modelLabel } from "../logic/modelLabel";
import { store, useAppState } from "../state/app";
import { SESSION_TOOLS, setSessionTool, useSessionTool } from "../state/sessionTool";
import { MIN_TOUCH, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { effortLevels, effortName } from "./ModelPicker";
import { PROVIDER_NAMES } from "./ProviderMark";
import { Text } from "./Text";

type Field = "tool" | "model" | "effort";
type Choice = { value: string | null; label: string; detail?: string; selected: boolean; apply: () => void };

const TITLES: Record<Field, string> = { tool: "Default tool", model: "Codex model", effort: "Codex reasoning effort" };

function modelEffort(model: MobileModel, preferred?: MobileCodexDefaults["effort"]) {
  return preferred && model.levels.includes(preferred) ? preferred : model.defaultLevel ?? fallbackEffort(model.levels);
}

function modelSummary(provider: MobileModelProvider | null | undefined, modelId: string | null, effort: MobileCodexDefaults["effort"]) {
  if (!modelId) return "Codex CLI default";
  const model = provider?.models.find((item) => item.value === modelId);
  const level = model ? modelEffort(model, effort) : effort;
  const name = modelLabel("codex", modelId, provider);
  return level ? `${name} · ${effortName(level)}` : name;
}

export function SessionDefaultsSettings() {
  const online = useAppState((s) => s.conn === "online");
  const defaults = useAppState((s) => s.codexDefaults);
  const provider = useAppState((s) => s.modelProviders.codex);
  const tool = useSessionTool();
  const [field, setField] = useState<Field | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState(false);
  const pending = useRef(false);

  useFocusEffect(useCallback(() => {
    if (!online) return;
    let active = true;
    void store.loadCodexSettings().then(
      () => { if (active) setReadError(false); },
      () => { if (active) setReadError(true); },
    );
    return () => { active = false; };
  }, [online]));

  const retry = () => {
    setReadError(false);
    void store.loadCodexSettings().catch(() => setReadError(true));
  };
  const open = (next: Field) => {
    setError(null);
    setField(next);
  };
  const close = () => { if (!pending.current) setField(null); };

  const save = async (patch: Partial<MobileCodexDefaults>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await store.setCodexDefaults(patch);
      setField(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save Codex defaults.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  const modelId = defaults?.model ?? provider?.defaultModel ?? null;
  const model = provider?.models.find((item) => item.value === modelId);
  const levels = model?.levels ?? effortLevels;
  const preferred = defaults?.effort ?? null;
  const appliedEffort = model ? modelEffort(model, preferred) : preferred;
  const ready = online && !!defaults && !!provider;
  const status = !online ? "Connect to your Mac to change Codex defaults."
    : readError ? "Could not load Codex defaults."
    : defaults === null ? "Update Lodestar on your Mac to change Codex defaults here."
    : defaults === undefined || provider === undefined ? "Loading Codex defaults…"
    : !provider ? "Codex models are unavailable on your Mac."
    : "Codex defaults sync with your Mac.";

  let choices: Choice[] = [];
  if (field === "tool") {
    choices = SESSION_TOOLS.map((value) => ({
      value, label: PROVIDER_NAMES[value], selected: tool === value,
      apply: () => { setSessionTool(value); close(); },
    }));
  } else if (field === "model") {
    choices = [
      { value: null, label: "Use Codex CLI default", selected: defaults?.model === null, apply: () => void save({ model: null }) },
      ...(provider?.models ?? []).map((item) => {
        const level = modelEffort(item, preferred);
        return {
          value: item.value,
          label: modelLabel("codex", item.value, provider),
          detail: level ? effortName(level) : undefined,
          selected: item.value === defaults?.model,
          apply: () => void save({ model: item.value }),
        };
      }),
    ];
  } else if (field === "effort") {
    choices = [
      { value: null, label: "Use model default", selected: defaults?.effort === null, apply: () => void save({ effort: null }) },
      ...levels.map((value) => ({
        value, label: effortName(value), selected: defaults?.effort === value,
        apply: () => void save({ effort: value }),
      })),
    ];
  }

  return <>
    <SettingRow title={TITLES.tool} value={PROVIDER_NAMES[tool]} onPress={() => open("tool")} />
    <SettingRow title={TITLES.model} value={modelSummary(provider, modelId, appliedEffort)} disabled={!ready} onPress={() => open("model")} />
    <SettingRow title={TITLES.effort} value={appliedEffort ? effortName(appliedEffort) : "Model default"} disabled={!ready} onPress={() => open("effort")} />
    <Text variant="caption" color={readError && online ? "danger" : "textMuted"}>{status}</Text>
    {readError && online && <Button title="Try again" kind="plain" onPress={retry} />}
    {field && <ChoiceSheet title={TITLES[field]} choices={choices} disabled={saving || (field !== "tool" && !ready)} saving={saving} error={error} close={close} />}
  </>;
}

function SettingRow({ title, value, disabled, onPress }: { title: string; value: string; disabled?: boolean; onPress: () => void }) {
  const colors = useColors();
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={`${title}, ${value}`}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.row, { borderBottomColor: colors.separator, opacity: disabled ? 0.55 : pressed ? 0.75 : 1 }]}
  >
    <View style={styles.field}>
      <Text variant="bodyStrong">{title}</Text>
      <Text variant="secondary" color="textMuted">{value}</Text>
    </View>
    <Icon name="chevron.right" size={15} color="textSubtle" />
  </Pressable>;
}

function ChoiceSheet({ title, choices, saving, disabled, error, close }: { title: string; choices: Choice[]; saving: boolean; disabled: boolean; error: string | null; close: () => void }) {
  const colors = useColors();
  return <Modal visible animationType="slide" onRequestClose={close}>
    <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.sheet, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <Text accessibilityRole="header" variant="title" style={styles.field}>{title}</Text>
        <Button title="Close" kind="plain" icon="xmark" disabled={saving} onPress={close} />
      </View>
      {error && <Text accessibilityLiveRegion="polite" variant="secondary" color="danger" style={styles.message}>{error}</Text>}
      {saving && <Text accessibilityLiveRegion="polite" variant="secondary" color="textMuted" style={styles.message}>Saving…</Text>}
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {choices.map(({ value, label, detail, selected, apply }) =>
          <Pressable key={value ?? "default"} accessibilityRole="radio" accessibilityLabel={detail ? `${label}, ${detail}` : label} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={selected ? close : apply}
            style={({ pressed }) => [styles.choice, { backgroundColor: pressed ? colors.pressed : colors.surface }]}>
            <View style={styles.field}>
              <Text variant="bodyStrong">{label}</Text>
              {detail && <Text variant="caption" color="textMuted">{detail}</Text>}
            </View>
            <Icon name={selected ? "largecircle.fill.circle" : "circle"} size={18} color={selected ? "accentText" : "textMuted"} />
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  row: { minHeight: MIN_TOUCH, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  field: { flex: 1, minWidth: 0 },
  sheet: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  message: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  list: { padding: spacing.lg, gap: spacing.xs },
  choice: { minHeight: MIN_TOUCH, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
});
