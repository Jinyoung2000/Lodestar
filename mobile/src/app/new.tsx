import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileFileRef, MobileModelSelection } from "@shared/mobile";
import type { BranchesResult, ImageRef } from "@shared/protocol";
import { pickableWorkspaces } from "../logic/agents";
import { baseChoices, branchLabel, canStartWorktree, defaultBaseBranch, shortPath, topWorkspace, worktreeDisabledReason, worktreePreview } from "../logic/workspaces";
import { store, useAppState } from "../state/app";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Composer } from "../ui/Composer";
import { ConnectionTitle } from "../ui/ConnectionTitle";
import { useFoldLayout } from "../ui/FoldLayout";
import { Icon } from "../ui/Icon";
import { KeyboardSpacer, useKeyboardTop } from "../ui/KeyboardSpacer";
import { ModelPicker, useModelPicker } from "../ui/ModelPicker";
import { Text } from "../ui/Text";

type Place = "here" | "worktree" | { existing: string };

export default function NewSession() {
  const router = useRouter();
  const colors = useColors();
  const { expanded, connectionInRail } = useFoldLayout();
  const params = useLocalSearchParams<{ draft?: string; workspace?: string; place?: string; location?: string }>();
  const [contextOpen, setContextOpen] = useState(params.place === "worktree");
  const workspaces = useAppState((s) => s.workspaces);
  const agents = useAppState((s) => s.agents);
  const conn = useAppState((s) => s.conn);
  const [modelChoice, setModelChoice] = useState<MobileModelSelection>();
  const [starting, setStarting] = useState(false);
  const model = useModelPicker(undefined, modelChoice);
  const { open: modelOpen, close: closeModel } = model;
  const keyboardTop = useKeyboardTop();
  const { height: windowHeight } = useWindowDimensions();
  useFocusEffect(useCallback(() => {
    if (!modelOpen && !contextOpen) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (modelOpen) closeModel();
      else setContextOpen(false);
      return true;
    });
    return () => back.remove();
  }, [modelOpen, contextOpen, closeModel]));
  const choices = useMemo(() => pickableWorkspaces(workspaces, agents), [workspaces, agents]);
  const fromLink = params.workspace ? topWorkspace(workspaces, params.workspace)?.id : undefined;
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const selected = picked === undefined ? (fromLink ?? choices[0]?.id ?? null) : picked;
  const [place, setPlace] = useState<Place | undefined>(undefined);
  const project = selected ? workspaces.find((w) => w.id === selected) : undefined;
  const worktrees = useMemo(() => (project ? workspaces.filter((w) => w.parentId === project.id && !w.feedback) : []), [workspaces, project]);
  const effectivePlace: Place = place ?? (params.location && worktrees.some((w) => w.id === params.location) ? { existing: params.location } : params.place === "worktree" ? "worktree" : "here");

  const [info, setInfo] = useState<BranchesResult | null>(null);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [pickingBase, setPickingBase] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setInfo(null);
    setBase("");
    setProblem(null);
    setPickingBase(false);
    if (!selected || conn !== "online") return;
    let stale = false;
    void store
      .branches(selected)
      .then((result) => {
        if (stale) return;
        setInfo(result);
        setBase(defaultBaseBranch(result));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [selected, conn]);

  const wantsWorktree = effectivePlace === "worktree";
  useEffect(() => {
    if (!wantsWorktree || !selected || !branch.trim() || conn !== "online") {
      setProblem(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void store
        .checkBranchName(selected, branch.trim())
        .then((result) => !stale && setProblem(result.problem))
        .catch(() => !stale && setProblem(null));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [wantsWorktree, selected, branch, conn]);

  const worktreeOk = canStartWorktree(info);
  const disabledReason = worktreeDisabledReason(info);
  const existingWorktree = typeof effectivePlace === "object" ? worktrees.find((w) => w.id === effectivePlace.existing) : undefined;
  const locationLabel = existingWorktree ? branchLabel(existingWorktree, agents) : wantsWorktree ? branch.trim() || "New worktree" : info?.current;
  const contextLabel = project ? [project.name, locationLabel].filter(Boolean).join(" · ") : "Chat";

  const start = async (text: string, images: ImageRef[], files: MobileFileRef[]) => {
    let workspaceId = selected;
    let worktree: { branch: string; base: string } | undefined;
    if (selected && effectivePlace === "worktree") {
      if (!branch.trim()) throw new Error("Give the new worktree a branch name");
      if (problem) throw new Error(problem);
      if (!base) throw new Error("Pick a branch to start from");
      worktree = { branch: branch.trim(), base };
    } else if (selected && typeof effectivePlace === "object") {
      workspaceId = effectivePlace.existing;
    }
    setStarting(true);
    try {
      const agent = await store.createSession(workspaceId, text, images, worktree, modelChoice, files);
      router.replace({ pathname: "/session/[id]", params: { id: agent.id } });
    } finally {
      setStarting(false);
    }
  };

  const sub = (dir: string) => shortPath(dir);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !modelOpen }} />
      <View style={styles.fill} pointerEvents={modelOpen ? "none" : "auto"} accessibilityElementsHidden={modelOpen} importantForAccessibility={modelOpen ? "no-hide-descendants" : "auto"}>
        {!modelOpen && <SafeAreaView edges={["top", "left", "right"]}>
          <View style={styles.appBar}>
            <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Close new session" : "Back"}
              onPress={() => router.canGoBack() ? router.back() : router.replace("/")}
              style={({ pressed }) => [styles.barButton, pressed && { backgroundColor: colors.pressed }]}>
              <Icon name={expanded ? "xmark" : "chevron.left"} size={20} color="textStrong" />
            </Pressable>
            <ConnectionTitle title="New session" subtitle={contextLabel} hidden={connectionInRail} style={styles.appBarLabels}>
              <Text accessibilityRole="header" variant="title" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.2}>New session</Text>
            </ConnectionTitle>
            <Pressable accessibilityRole="button" accessibilityLabel={`Workspace and location, ${contextLabel}`} accessibilityState={{ expanded: contextOpen }}
              onPress={() => { Keyboard.dismiss(); setContextOpen((open) => !open); }}
              style={({ pressed }) => [styles.barButton, pressed && { backgroundColor: colors.pressed }]}>
              <Icon name="folder" size={20} color={contextOpen ? "accentText" : "textStrong"} />
            </Pressable>
          </View>
        </SafeAreaView>}
        <View style={styles.fill}>
          {contextOpen && <ScrollView style={styles.fill} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
            <Text variant="secondary" color="textMuted" style={styles.label}>Folder</Text>
            {choices.map((w) => (
              <Choice key={w.id} title={w.name} subtitle={sub(w.dir)} selected={selected === w.id} onPress={() => { setPicked(w.id); setPlace(undefined); }} />
            ))}
            <Choice title="Chat" subtitle="No folder, no files" selected={selected === null} onPress={() => setPicked(null)} />
            {choices.length === 0 && (
              <Pressable accessibilityRole="button" onPress={() => router.push("/add-workspace")} style={styles.link}>
                <Text color="accentText">Add a workspace first</Text>
              </Pressable>
            )}

            {project && (
              <View style={{ gap: spacing.sm }}>
                <Text variant="secondary" color="textMuted" style={[styles.label, { marginTop: spacing.md }]}>Start in</Text>
                <Choice title="This folder" subtitle={info ? (info.current ? `Branch ${info.current}${info.uncommitted > 0 ? ` · ${info.uncommitted} uncommitted` : ""}` : "The folder as it is") : "The folder as it is"} selected={effectivePlace === "here"} onPress={() => setPlace("here")} />
                <Choice title="New worktree" subtitle={disabledReason ?? "A separate copy on its own new branch"} selected={wantsWorktree} disabled={!worktreeOk} onPress={() => setPlace("worktree")} />
                {worktrees.map((w) => (
                  <Choice key={w.id} title={branchLabel(w, agents)} subtitle="Existing worktree" icon="arrow.triangle.branch" selected={typeof effectivePlace === "object" && effectivePlace.existing === w.id} onPress={() => setPlace({ existing: w.id })} />
                ))}

                {wantsWorktree && info?.repoRoot && (
                  <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                    <Text variant="secondary" color="textMuted" style={styles.label}>New branch name</Text>
                    <TextInput
                      accessibilityLabel="Branch name"
                      value={branch}
                      onChangeText={setBranch}
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      placeholder="feature/my-change"
                      placeholderTextColor={colors.textMuted}
                      style={[styles.input, { color: colors.textStrong, borderColor: problem ? colors.danger : colors.border, backgroundColor: colors.background }]}
                    />
                    {problem ? <Text variant="secondary" color="danger">{problem}</Text> : <Text variant="caption" color="textSubtle">Creates {worktreePreview(info.repoRoot, branch)}</Text>}
                    <Text variant="secondary" color="textMuted" style={[styles.label, { marginTop: spacing.sm }]}>Start from</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Start from ${base}`} onPress={() => setPickingBase((open) => !open)} style={[styles.baseRow, { borderColor: colors.border, backgroundColor: colors.background }]}>
                      <Icon name="arrow.triangle.branch" size={16} color="textMuted" />
                      <Text color="textStrong" style={{ flex: 1 }} numberOfLines={1}>{base || "Pick a branch"}</Text>
                      <Icon name={pickingBase ? "chevron.up" : "chevron.down"} size={13} color="textSubtle" />
                    </Pressable>
                    {pickingBase && (
                      <View style={[styles.baseList, { borderColor: colors.border }]}>
                        <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
                          {baseChoices(info).map((name) => (
                            <Pressable key={name} accessibilityRole="radio" accessibilityState={{ checked: name === base }} onPress={() => { setBase(name); setPickingBase(false); }} style={[styles.baseItem, { borderBottomColor: colors.separator }]}>
                              <Text style={{ flex: 1 }} numberOfLines={1} color={name === base ? "accentText" : "text"}>{name}</Text>
                              {name === base && <Icon name="checkmark" size={16} color="accentText" weight="bold" />}
                            </Pressable>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </View>
                )}
              </View>
            )}
          </ScrollView>}
        </View>
        <Composer
          agent={undefined}
          initialText={params.draft}
          draftKey="new"
          disabled={conn !== "online" || modelOpen}
          placeholder="Describe the task"
          autoFocus={!contextOpen}
          onSend={(text, images, _steer, files) => start(text, images, files)}
          modelControl={{ harness: model.selection.harness, name: model.name, effort: model.effort, onPress: model.show, disabled: starting }}
        />
        {!expanded && <KeyboardSpacer />}
      </View>
      {modelOpen && <ModelPicker
        selection={model.selection}
        canResetDraft={!!modelChoice}
        onResetDraft={() => setModelChoice(undefined)}
        close={model.close}
        keyboardInset={expanded || keyboardTop === undefined ? 0 : Math.max(0, windowHeight - keyboardTop)}
        apply={async (selection) => {
          setModelChoice(selection.harness === "claude" && selection.model === null && selection.effort === null ? undefined : selection);
          return selection;
        }}
      />}
    </View>
  );
}

function Choice({ title, subtitle, selected: on, disabled, icon, onPress }: { title: string; subtitle: string; selected: boolean; disabled?: boolean; icon?: "arrow.triangle.branch"; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, { borderColor: on ? colors.accent : colors.separator, backgroundColor: colors.surface, opacity: disabled ? 0.5 : 1 }]}>
      {icon && <Icon name={icon} size={18} color="textMuted" />}
      <View style={{ flex: 1 }}>
        <Text variant="title" color="textStrong" numberOfLines={1}>{title}</Text>
        <Text variant="secondary" color="textMuted" numberOfLines={2}>{subtitle}</Text>
      </View>
      {on && <Icon name="checkmark" size={18} color="accentText" weight="bold" />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  appBar: { flexDirection: "row", alignItems: "center", minHeight: 48, paddingHorizontal: spacing.xs, gap: spacing.xs },
  barButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  appBarLabels: { flex: 1, minWidth: 0 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  label: { fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: spacing.xs },
  link: { minHeight: MIN_TOUCH, justifyContent: "center", alignItems: "center" },
  choice: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 60, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1.5 },
  panel: { gap: spacing.xs, padding: spacing.lg, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, fontSize: 16 },
  baseRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  baseList: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  baseItem: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
});
