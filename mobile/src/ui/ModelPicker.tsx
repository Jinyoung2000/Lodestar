import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Image, Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SwitchBlock } from "@shared/harnessSwitch";
import type { MobileModelProvider, MobileModelSelection } from "@shared/mobile";
import type { Agent, EffortLevel, Harness } from "@shared/protocol";
import { modelLabel } from "../logic/modelLabel";
import { store, useAppState } from "../state/app";
import { MODEL_HARNESSES } from "../state/store";
import { spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { useFoldLayout } from "./FoldLayout";
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
};

function modelOf(provider: MobileModelProvider, model: string | null) {
  const id = model ?? provider.defaultModel;
  return provider.models.find((entry) => entry.value === id) ?? provider.models.find((entry) => id !== null && entry.resolved === id);
}

export function useModelPicker(agent?: Agent, draft?: MobileModelSelection) {
  const [open, setOpen] = useState(false);
  const selection = agent
    ? { harness: agent.harness ?? "claude", model: agent.model, effort: agent.effort }
    : draft ?? DEFAULT_MODEL_SELECTION;
  const { harness } = selection;
  const provider = useAppState((state) => state.modelProviders[harness]);
  const selected = selection.model === "default" ? null : selection.model;
  const modelId = selected ?? agent?.activeModel ?? provider?.defaultModel ?? null;
  const model = provider ? modelOf(provider, modelId) : undefined;
  const name = modelId ? modelLabel(harness, modelId, provider, agent?.activeModel) : "…";
  const effort = selection.effort ?? agent?.activeEffort ?? model?.defaultLevel ?? null;
  const show = useCallback(() => {
    Keyboard.dismiss();
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { open, show, close, name, effort, selection };
}

export function modelPickerLabel(name: string, effort: EffortLevel | null) {
  return `Model ${name}${effort ? `, effort ${EFFORT_NAMES[effort]}` : ""}. Change`;
}

export function CompactEffort({ effort }: { effort: EffortLevel }) {
  return <View style={styles.subtitle}>
    <Text variant="caption" color="textMuted" maxFontSizeMultiplier={1.3}>{EFFORT_NAMES[effort]}</Text>
    <View style={styles.subtitleChevron}><Icon name="chevron.down" size={10} color="textSubtle" /></View>
  </View>;
}

export function ModelSubtitle({ name, effort }: { name: string; effort: EffortLevel | null }) {
  return <View style={styles.subtitle}>
    <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.modelLabel}>{name}</Text>
    {effort && <Text variant="caption" color="textMuted" maxFontSizeMultiplier={1.3}>{` · ${EFFORT_NAMES[effort]}`}</Text>}
    <View style={styles.subtitleChevron}><Icon name="chevron.down" size={10} color="textSubtle" /></View>
  </View>;
}

type Props = {
  agentId?: string;
  selection: MobileModelSelection;
  canResetDraft?: boolean;
  onResetDraft?: () => void;
  close: () => void;
  keyboardInset?: number;
  apply: (choice: MobileModelSelection) => Promise<MobileModelSelection>;
};

export function ModelPicker({ agentId, selection, canResetDraft, onResetDraft, close, keyboardInset = 0, apply }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { paneWidth, fontScale } = useFoldLayout();
  const searchHint = paneWidth < 360 && fontScale >= 1.3 ? "Search" : "Find a model";
  const available = useAppState((state) => state.modelProviders);
  const favorites = useAppState((state) => state.modelPins);
  const online = useAppState((state) => state.conn === "online");
  const [switchBlock, setSwitchBlock] = useState<SwitchBlock | null | undefined>(agentId ? undefined : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<"models" | "reasoning" | "filter">("models");
  const [query, setQuery] = useState("");
  const [chosenFilter, setFilter] = useState<Harness | "favorites" | null>();
  const [collapsed, setCollapsed] = useState<Partial<Record<Harness, boolean>>>({});
  const [changingPin, setChangingPin] = useState(false);
  const [draft, setDraft] = useState<MobileModelSelection | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!online) return;
    let live = true;
    setLoadError(null);
    setError(null);
    const failed = (cause: Error) => { if (live) setLoadError(cause.message); };
    void store.warmModels().catch(failed);
    void store.loadModelPins().catch((cause: Error) => {
      if (live) setError(cause.message.includes("cannot call") ? "Update Lodestar on your Mac to sync favorites." : cause.message);
    });
    if (agentId) {
      void store.modelSwitchBlock(agentId, selection.harness).then((value) => { if (live) setSwitchBlock(value); }, failed);
    }
    return () => { live = false; };
  }, [agentId, online, retry, selection.harness]);

  useEffect(() => {
    if (page === "models" && !saving) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (saving) return true;
      setPage("models");
      return true;
    });
    return () => back.remove();
  }, [page, saving]);

  const displayed = draft ?? selection;
  const providers = MODEL_HARNESSES.flatMap((harness) => available[harness] ?? []);
  const loading = online && !loadError && MODEL_HARNESSES.some((harness) => available[harness] === undefined);
  const filter = chosenFilter === undefined ? (!query.trim() && favorites?.length ? "favorites" : null) : chosenFilter;
  const pinOrder = new Map(favorites?.map((key, index) => [key, index]));
  const provider = providers.find((entry) => entry.harness === displayed.harness);
  const current = provider && modelOf(provider, displayed.model);
  const effort = displayed.effort ?? current?.defaultLevel ?? null;
  const changed = displayed.harness !== selection.harness || displayed.model !== selection.model || displayed.effort !== selection.effort;
  const narrowed = !!query.trim() || filter !== null;
  const needle = query.trim().toLowerCase();
  const groups = providers.flatMap((entry) => {
    if (filter && filter !== "favorites" && filter !== entry.harness) return [];
    const models = entry.models.filter((model) => {
      return (filter !== "favorites" || (model.pinKey !== undefined && pinOrder.has(model.pinKey))) && [PROVIDER_NAMES[entry.harness], model.displayName, modelLabel(entry.harness, model.value, entry), model.value].some((value) => value.toLowerCase().includes(needle));
    }).sort((a, b) => (pinOrder.get(a.pinKey ?? "") ?? pinOrder.size) - (pinOrder.get(b.pinKey ?? "") ?? pinOrder.size));
    return models.length ? [{ entry, models }] : [];
  });

  const favorite = async (harness: Harness, model: string, pinned: boolean) => {
    setChangingPin(true);
    setError(null);
    try { await store.setModelPin(harness, model, pinned); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save favorite."); }
    finally { setChangingPin(false); }
  };
  const choose = (entry: MobileModelProvider, model: string | null) => {
    setError(null);
    if (entry.harness === selection.harness && model === selection.model) {
      setDraft(null);
      return;
    }
    if (entry.harness === displayed.harness && model === displayed.model) return;
    const next = modelOf(entry, model);
    const level = model && displayed.effort && next?.levels.includes(displayed.effort) ? displayed.effort : null;
    setDraft({ harness: entry.harness, model, effort: level });
  };
  const save = async (choice: MobileModelSelection, dismiss: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await apply(choice);
      setDraft(null);
      if (dismiss) close();
      else setPage("models");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the model.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const chooseEffort = (level: EffortLevel) => {
    if (draft && changed) {
      setDraft({ ...draft, effort: level });
      setPage("models");
    } else {
      void save({ ...displayed, effort: level }, false);
    }
  };
  const chooseFilter = (next: typeof filter) => { setFilter(next); setPage("models"); };
  const navigationIcon = page === "models" ? "xmark" : "chevron.left";
  const exit = () => { if (!inFlight.current) close(); };

  return <View accessibilityViewIsModal onAccessibilityEscape={exit} style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: keyboardInset || insets.bottom }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={page === "models" ? "Cancel thread settings" : "Back to models"} disabled={saving} style={styles.target} onPress={page === "models" ? exit : () => setPage("models")}>
          <Icon name={navigationIcon} size={20} color="textMuted" />
        </Pressable>
        {page !== "models" && <Text color="textStrong" numberOfLines={1} style={styles.title}>{page === "filter" ? "Model filters" : "Reasoning effort"}</Text>}
        {page === "models" && <>
          <View style={[styles.search, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}>
            <Icon name="magnifyingglass" size={16} color="textMuted" />
            <TextInput value={query} onChangeText={setQuery} accessibilityLabel="Find a model" placeholder={searchHint} placeholderTextColor={colors.textMuted} autoCorrect={false} autoCapitalize="none" returnKeyType="search" style={[styles.searchInput, { color: colors.textStrong }]} />
            {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear model search" hitSlop={6} style={styles.clear} onPress={() => setQuery("")}><Icon name="xmark" size={14} color="textMuted" /></Pressable>}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Model filters" style={styles.target} onPress={() => { Keyboard.dismiss(); setPage("filter"); }}>
            <Icon name="line.3.horizontal.decrease" size={18} color={filter ? "accentText" : "textMuted"} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={changed ? "Save" : "Done"} disabled={saving} style={styles.target} onPress={() => changed ? void save(displayed, true) : exit()}>
            {saving ? <ActivityIndicator size="small" color={colors.accentText} /> : <Text color="accentText" variant="secondary" style={styles.bold}>{changed ? "Save" : "Done"}</Text>}
          </Pressable>
        </>}
      </View>
      {!!error && <Text color="danger" variant="caption" accessibilityLiveRegion="polite" style={styles.note}>{error}</Text>}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
        {page === "models" && <>
          {loadError ? <View><Text variant="secondary" color="textMuted">{loadError}</Text>{!loadError.startsWith("Update Lodestar") && <Button title="Try again" kind="plain" onPress={() => { setLoadError(null); setRetry((n) => n + 1); }} />}</View> : loading && !groups.length && <ActivityIndicator color={colors.textMuted} />}
          {switchBlock && <Text variant="caption" color="textMuted" style={styles.note}>{SWITCH_MESSAGES[switchBlock]}</Text>}
          {groups.map(({ entry, models }) => {
            const name = PROVIDER_NAMES[entry.harness];
            const hidden = !narrowed && (collapsed[entry.harness] ?? (entry.harness === "antigravity" && displayed.harness !== "antigravity"));
            const locked = !online || saving || (switchBlock !== null && entry.harness !== selection.harness);
            return <View key={entry.harness}>
              <Pressable accessibilityRole="button" accessibilityLabel={name} accessibilityState={{ expanded: !hidden }} disabled={narrowed} style={styles.groupHead} onPress={() => setCollapsed((old) => ({ ...old, [entry.harness]: !hidden }))}>
                <ProviderMark harness={entry.harness} size={16} /><Text color="textMuted" style={styles.bold}>{name}</Text>
                <Text variant="caption" color="textMuted" style={styles.flex}>{models.length}</Text>
                {!narrowed && <Icon name={hidden ? "chevron.right" : "chevron.down"} size={14} color="textMuted" />}
              </Pressable>
              {!hidden && <View style={[styles.group, { backgroundColor: colors.surfaceBase }]}>
                {!narrowed && <Choice label={entry.harness === "claude" ? "Mac default" : `${name} default`} checked={entry.harness === displayed.harness && displayed.model === null} disabled={locked} onPress={() => choose(entry, null)} />}
                {models.map((model) => {
                  const key = `${entry.harness}/${model.value}`;
                  const label = modelLabel(entry.harness, model.value, entry);
                  const starred = !!model.pinKey && pinOrder.has(model.pinKey);
                  return <View key={key} style={styles.modelRow}>
                    <Choice label={label} checked={entry.harness === displayed.harness && displayed.model !== null && model.value === current?.value} disabled={locked} onPress={() => choose(entry, model.value)} />
                    <Pressable accessibilityRole="button" accessibilityLabel={`${starred ? "Unfavorite" : "Favorite"} ${label}`} accessibilityState={{ selected: starred }} disabled={!online || !favorites || !model.pinKey || changingPin} style={styles.target} onPress={() => void favorite(entry.harness, model.value, !starred)}>
                      <Image accessible={false} importantForAccessibility="no" source={starred ? require("../../assets/model-picker/favorite.png") : require("../../assets/model-picker/favorite-outline.png")} style={{ width: 17, height: 17, tintColor: starred ? colors.accentText : colors.textMuted }} />
                    </Pressable>
                  </View>;
                })}
              </View>}
            </View>;
          })}
          {!loading && !loadError && !groups.length && <Text variant="secondary" style={styles.note} color="textMuted">{needle ? "No matching models" : filter === "favorites" ? "No favorite models" : "No models available"}</Text>}
          {!!current?.levels.length && <View>
            <Text variant="secondary" color="textMuted" style={styles.groupHeadText}>Options</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Reasoning effort, ${effort ?? "Default"}`} disabled={saving} style={[styles.disclosure, { backgroundColor: colors.surfaceBase }]} onPress={() => { Keyboard.dismiss(); setPage("reasoning"); }}>
              <Text style={styles.flex}>Reasoning effort</Text><Text variant="secondary" color="textMuted">{effort ? EFFORT_NAMES[effort] : "Default"}</Text><Icon name="chevron.right" size={15} color="textMuted" />
            </Pressable>
          </View>}
          {!providers.length && canResetDraft && <Button title="Use Mac defaults" kind="plain" onPress={() => { onResetDraft?.(); close(); }} />}
        </>}
        {page === "reasoning" && <View style={[styles.group, { backgroundColor: colors.surfaceBase }]}>
          {current?.levels.map((level) => <Choice key={level} label={level === "medium" ? "Medium" : EFFORT_NAMES[level]} checked={effort === level} disabled={saving} onPress={() => chooseEffort(level)} />)}
        </View>}
        {page === "filter" && <View style={[styles.group, { backgroundColor: colors.surfaceBase }]}>
          <Choice label="All providers" checked={!filter} onPress={() => chooseFilter(null)} />
          <Choice label="Favorites" checked={filter === "favorites"} onPress={() => chooseFilter("favorites")} />
          {providers.map((entry) => <Choice key={entry.harness} label={PROVIDER_NAMES[entry.harness]} checked={filter === entry.harness} onPress={() => chooseFilter(entry.harness)} />)}
        </View>}
      </ScrollView>
  </View>;
}

function Choice({ label, checked, disabled, onPress }: { label: string; checked: boolean; disabled?: boolean; onPress: () => void }) {
  const colors = useColors();
  return <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked, disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.choice, { opacity: disabled ? 0.45 : 1, backgroundColor: pressed ? colors.pressed : "transparent" }]}>
    <Icon name={checked ? "largecircle.fill.circle" : "circle"} size={17} color={checked ? "accentText" : "textMuted"} />
    <Text numberOfLines={2} color="textStrong" style={styles.choiceLabel}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  subtitle: { minWidth: 0, flexShrink: 1, flexDirection: "row", alignItems: "center" },
  modelLabel: { minWidth: 0, flexShrink: 1 },
  subtitleChevron: { marginLeft: spacing.xs },
  screen: { ...StyleSheet.absoluteFill, zIndex: 3 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: "600" },
  target: { minWidth: 44, minHeight: 48, alignItems: "center", justifyContent: "center" },
  search: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, minWidth: 0, minHeight: 40, padding: 0, fontSize: 15 },
  clear: { width: 24, height: 36, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  groupHead: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 42, paddingHorizontal: 4 },
  groupHeadText: { paddingHorizontal: 4, paddingTop: 12, paddingBottom: 6 },
  group: { borderRadius: 12, overflow: "hidden" },
  modelRow: { flexDirection: "row", alignItems: "center" },
  choice: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0, minHeight: 48, gap: 10, paddingHorizontal: 12, paddingVertical: 4, flexDirection: "row", alignItems: "center" },
  choiceLabel: { flex: 1, fontSize: 15, lineHeight: 20 },
  disclosure: { borderRadius: 12, minHeight: 48, paddingHorizontal: 12, gap: 8, flexDirection: "row", alignItems: "center" },
  flex: { flex: 1, minWidth: 0 },
  note: { paddingHorizontal: 10, paddingVertical: 6 },
  bold: { fontWeight: "600" },
});
