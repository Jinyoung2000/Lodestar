import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Keyboard, PanResponder, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SwitchBlock } from "@shared/harnessSwitch";
import type { MobileModelCatalog, MobileModelProvider, MobileModelSelection } from "@shared/mobile";
import type { Agent, EffortLevel, Harness } from "@shared/protocol";
import { store } from "../state/app";
import { scrim, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { PROVIDER_NAMES, ProviderMark } from "./ProviderMark";
import { Text } from "./Text";

export const DEFAULT_MODEL_SELECTION: MobileModelSelection = { harness: "claude", model: null, effort: null };
const EFFORT_NAMES: Record<EffortLevel, string> = { low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra" };
const SWITCH_MESSAGES: Record<SwitchBlock, string> = {
  running: "Wait for the reply to finish before switching tools",
  background: "Wait for the background tasks to finish before switching tools",
  waiting: "Answer the pending request before switching tools",
  notion: "Notion page chats run on Claude only",
  feedback: "Improvement sessions run on Claude only",
  imported: "Sessions imported from VS Code run on Claude only",
};

function modelOf(provider: MobileModelProvider, model: string | null) {
  const id = model ?? provider.defaultModel;
  return provider.models.find((entry) => entry.value === id) ?? provider.models.find((entry) => id !== null && entry.resolved === id);
}

export function useModelPicker(online: boolean, agent?: Agent, draft?: MobileModelSelection) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<MobileModelCatalog | null>(null);
  const [prefetched, setPrefetched] = useState<MobileModelProvider | null>(null);
  const selection = agent
    ? { harness: agent.harness ?? "claude", model: agent.model, effort: agent.effort }
    : draft ?? DEFAULT_MODEL_SELECTION;
  const { harness } = selection;
  const provider = catalog?.providers.find((entry) => entry.harness === harness) ?? (prefetched?.harness === harness ? prefetched : undefined);
  const model = provider ? modelOf(provider, selection.model) : undefined;
  const modelId = selection.model ?? agent?.activeModel ?? null;
  const name = (selection.model !== null || provider?.defaultModelKnown ? model?.displayName : null) ?? modelId ?? "Default model";
  const effort = selection.effort ?? model?.defaultLevel ?? agent?.activeEffort ?? null;
  useEffect(() => {
    if (!online) return;
    let active = true;
    void store.models(undefined, harness).then((value) => {
      if (active) setPrefetched(value.providers[0] ?? null);
    }).catch(() => {});
    return () => { active = false; };
  }, [harness, online]);
  const show = useCallback(() => {
    Keyboard.dismiss();
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { open, show, close, setCatalog, name, effort, selection };
}

export function modelPickerLabel(name: string, effort: EffortLevel | null) {
  return `Model ${name}${effort ? `, effort ${EFFORT_NAMES[effort]}` : ""}. Change`;
}

export function ModelSubtitle({ name, effort, draft = false }: { name: string; effort: EffortLevel | null; draft?: boolean }) {
  return <View style={styles.subtitle}>
    <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.modelLabel, draft && styles.draftLabel]}>{name}</Text>
    {effort && <Text variant="caption" color="textMuted" maxFontSizeMultiplier={1.3} style={draft && styles.draftLabel}>{` · ${EFFORT_NAMES[effort]}`}</Text>}
    <View style={styles.subtitleChevron}><Icon name="chevron.down" size={10} color="textSubtle" /></View>
  </View>;
}

type Props = {
  agentId?: string;
  selection: MobileModelSelection;
  canResetDraft?: boolean;
  onResetDraft?: () => void;
  onCatalog: (catalog: MobileModelCatalog) => void;
  close: () => void;
  keyboardInset?: number;
  apply: (choice: MobileModelSelection) => Promise<MobileModelSelection>;
};

export function ModelPicker({ agentId, selection, canResetDraft, onResetDraft, onCatalog, close, keyboardInset = 0, apply }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [catalog, setCatalog] = useState<MobileModelCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [browse, setBrowse] = useState<Harness | null>(null);
  const [changing, setChanging] = useState<MobileModelSelection | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const translation = useRef(new Animated.Value(0)).current;
  const dismiss = useRef(close);
  dismiss.current = close;
  const drag = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 6 && gesture.dy > Math.abs(gesture.dx),
    onPanResponderMove: (_event, gesture) => translation.setValue(Math.max(0, gesture.dy)),
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy > 48 || gesture.vy > 0.6) dismiss.current();
      Animated.spring(translation, { toValue: 0, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(translation, { toValue: 0, useNativeDriver: true }).start(),
  }), [translation]);

  useEffect(() => {
    let active = true;
    void store.models(agentId).then((value) => {
      if (!active) return;
      setCatalog(value);
      onCatalog(value);
    }, (cause: Error) => {
      if (active) setLoadError(cause.message);
    });
    return () => { active = false; };
  }, [agentId, onCatalog, retry]);

  const providers = catalog?.providers ?? [];
  const blocked = catalog?.switchBlock;
  const provider = providers.find((entry) => entry.harness === (browse ?? selection.harness) && (!blocked || entry.harness === selection.harness))
    ?? providers.find((entry) => !blocked || entry.harness === selection.harness);
  const ownProvider = provider?.harness === selection.harness;
  const model = provider && ownProvider ? modelOf(provider, selection.model) : undefined;
  const defaultEffort = model?.defaultLevel ?? null;
  const selectedEffort = selection.effort ?? defaultEffort;
  const levels = model?.levels ?? [];
  const pendingModel = provider && changing?.model ? modelOf(provider, changing.model) : undefined;

  const submit = async (next: MobileModelSelection) => {
    if (pending.current) return;
    if (next.harness === selection.harness && next.model === selection.model && next.effort === selection.effort) return;
    pending.current = true;
    setChanging(next);
    setError(null);
    try {
      const saved = await apply(next);
      setBrowse(saved.harness);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the model.");
      if (agentId) void store.models(agentId).then((value) => { setCatalog(value); onCatalog(value); }).catch(() => {});
    } finally {
      pending.current = false;
      setChanging(null);
    }
  };

  const pickModel = (id: string | null) => {
    if (!provider) return;
    const next = modelOf(provider, id);
    const effort = id !== null && selection.effort && next?.levels.includes(selection.effort) ? selection.effort : null;
    void submit({ harness: provider.harness, model: id, effort });
  };

  return (
    <View style={[styles.scrim, { paddingBottom: keyboardInset }]}>
      <Pressable accessibilityLabel="Close model picker" onPress={close} style={StyleSheet.absoluteFill} />
      <Animated.View
        accessibilityViewIsModal
        onAccessibilityEscape={close}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: keyboardInset ? 0 : insets.bottom, transform: [{ translateY: translation }] }]}
      >
        <View style={styles.grabArea} {...drag.panHandlers}>
          <View style={[styles.grabber, { backgroundColor: colors.border }]} />
        </View>
        {!catalog && !loadError && <View style={styles.status}><ActivityIndicator /><Text variant="secondary" color="textMuted">Loading models…</Text></View>}
        {loadError && <View style={styles.loadError}>
          <Text variant="secondary" color="textMuted" accessibilityLiveRegion="polite">{loadError}</Text>
          {!loadError.startsWith("Update Lodestar") && <Button title="Try again" kind="plain" onPress={() => { setLoadError(null); setRetry((value) => value + 1); }} />}
        </View>}
        {catalog && !provider && <Text variant="secondary" color="textMuted" style={styles.status}>No models available on your Mac.</Text>}
        {providers.length > 1 && <View style={[styles.segment, { backgroundColor: colors.surfaceBase, borderColor: colors.separator }]} accessibilityRole="radiogroup">
          {providers.map((entry) => {
            const checked = provider === entry;
            const disabled = !!changing || (!!blocked && entry.harness !== selection.harness);
            return <Pressable
              key={entry.harness}
              accessibilityRole="radio"
              accessibilityState={{ checked, disabled }}
              disabled={disabled}
              onPress={() => { setError(null); setBrowse(entry.harness); }}
              style={[styles.segmentItem, checked && { backgroundColor: colors.selected }, disabled && !checked && { opacity: 0.48 }]}
            >
              <ProviderMark harness={entry.harness} state="idle" selected={checked} size={14} />
              <Text style={styles.providerName} color={checked ? "textStrong" : "textMuted"} maxFontSizeMultiplier={1.3} numberOfLines={1}>{PROVIDER_NAMES[entry.harness]}</Text>
            </Pressable>;
          })}
        </View>}
        {!!blocked && providers.some((entry) => entry.harness !== selection.harness) &&
          <Text variant="caption" color="textMuted" numberOfLines={1} accessibilityLabel={SWITCH_MESSAGES[blocked]} style={styles.hint}>{SWITCH_MESSAGES[blocked]}</Text>}
        {provider && <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" accessibilityRole="radiogroup">
          {(provider.harness === "claude" || provider.defaultModel !== null) && (
            <ModelRow label={provider.harness === "claude" ? "Mac default" : `${PROVIDER_NAMES[provider.harness]} default`} checked={ownProvider && selection.model === null} pending={changing?.model === null} disabled={!!changing} onPress={() => pickModel(null)} />
          )}
          {provider.models.map((entry) => <ModelRow key={entry.value} label={entry.displayName} checked={ownProvider && selection.model !== null && model?.value === entry.value} pending={pendingModel?.value === entry.value} disabled={!!changing} onPress={() => pickModel(entry.value)} />)}
        </ScrollView>}
        {error && <Text variant="caption" color="danger" numberOfLines={1} accessibilityLiveRegion="polite" accessibilityLabel={error} style={styles.hint}>{error}</Text>}
        {levels.length > 0 && <View style={[styles.effort, { borderColor: colors.separator }]}>
          <View style={[styles.segment, { backgroundColor: colors.surfaceBase, borderColor: colors.separator }]} accessibilityRole="radiogroup">
            {levels.map((level) => {
              const checked = selectedEffort === level;
              return <Pressable
                key={level}
                accessibilityRole="radio"
                accessibilityLabel={`Effort ${EFFORT_NAMES[level]}`}
                accessibilityState={{ checked, disabled: !!changing }}
                onPress={() => void submit({ ...selection, effort: level === defaultEffort ? null : level })}
                disabled={!!changing}
                style={[styles.segmentItem, checked && { backgroundColor: colors.selected }]}
              >
                <Text style={styles.effortName} color={checked ? "textStrong" : "textMuted"} maxFontSizeMultiplier={1.3}>{EFFORT_NAMES[level]}</Text>
              </Pressable>;
            })}
          </View>
        </View>}
        {!provider && canResetDraft && <Button title="Use Mac defaults" kind="plain" onPress={() => { onResetDraft?.(); close(); }} />}
      </Animated.View>
    </View>
  );
}

function ModelRow({ label, checked, pending, disabled, onPress }: { label: string; checked: boolean; pending: boolean; disabled: boolean; onPress: () => void }) {
  const colors = useColors();
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked, disabled, busy: pending }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
    <Text color="textStrong" numberOfLines={1} style={styles.rowName}>{label}</Text>
    {pending ? <ActivityIndicator size="small" color={colors.accentText} /> : checked && <Icon name="checkmark" size={18} color="accentText" weight="semibold" />}
  </Pressable>;
}

const styles = StyleSheet.create({
  subtitle: { flexDirection: "row", alignItems: "center" },
  modelLabel: { minWidth: 0, flexShrink: 1 },
  draftLabel: { fontSize: 13, lineHeight: 18 },
  subtitleChevron: { marginLeft: spacing.xs },
  scrim: { ...StyleSheet.absoluteFill, zIndex: 3, backgroundColor: scrim, justifyContent: "flex-end", alignItems: "center" },
  sheet: { width: "100%", maxWidth: 440, maxHeight: "70%", paddingHorizontal: spacing.lg, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  grabArea: { height: 20, alignItems: "center", justifyContent: "center" },
  grabber: { borderRadius: 2, height: 4, width: 30 },
  status: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.lg, alignItems: "center" },
  loadError: { gap: spacing.sm, paddingVertical: spacing.lg },
  hint: { paddingVertical: spacing.xs },
  segment: { minHeight: 36, flexDirection: "row", alignItems: "stretch", borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 2 },
  segmentItem: { flex: 1, minWidth: 0, minHeight: 30, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: 2, borderRadius: 6 },
  providerName: { fontSize: 13, lineHeight: 16, fontWeight: "600", flexShrink: 1 },
  list: { flexGrow: 0, flexShrink: 1 },
  row: { minHeight: 48, flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.xs, alignItems: "center", borderRadius: 8 },
  rowName: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  effort: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  effortName: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
});
