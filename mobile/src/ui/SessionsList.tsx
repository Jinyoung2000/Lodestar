import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Stack, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import type { Agent, TimelineItem } from "@shared/protocol";
import { groupAgents, workspaceName } from "../logic/agents";
import { buildProject, compareAgents, topWorkspace } from "../logic/workspaces";
import { readQuestions, PLAN_TOOL, QUESTION_TOOL } from "../logic/questions";
import { approvalTarget, describeTool } from "../logic/tools";
import { sortPrefs, store, useAppState, useSessionSort, useSortPrefs } from "../state/app";
import { radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { ProjectIcon, type ProjectMark } from "./ProjectIcon";
import { ConnectionBanner } from "./Banner";
import { Icon } from "./Icon";
import { RenameDialog } from "./RenameDialog";
import { Segmented } from "./Segmented";
import { SessionRow, SessionRowFrame } from "./SessionRow";
import { relativeTime } from "../logic/time";
import { Text } from "./Text";
import { useSessionActions } from "./sessionActions";
import { NEW_SESSION_CLEARANCE, NewSessionButton } from "./NewSessionButton";
import { WorkspacesView } from "./WorkspacesView";

type Item = { kind: "header"; key: string; title: string; count: number; mark: ProjectMark; workspaceId: string | null } | { kind: "session"; key: string; agent: Agent; workspace: string };
type Tab = "sessions" | "waiting" | "workspaces";

export function SessionsList({ docked = false, paneWidth, sessionId, workspaceId, onOpenSession, headerHeight = 0 }: {
  docked?: boolean;
  paneWidth?: number;
  sessionId?: string;
  workspaceId?: string;
  onOpenSession?: (id: string, focusQuestion: boolean) => void;
  headerHeight?: number;
}) {
  const router = useRouter();
  const colors = useColors();
  const agents = useAppState((s) => s.agents);
  const workspaces = useAppState((s) => s.workspaces);
  const conn = useAppState((s) => s.conn);
  const loaded = useAppState((s) => s.loaded);
  const { collapsed } = useSortPrefs();
  const searchBar = useRef<SearchBarCommands>(null);
  const [tab, setTab] = useState<Tab>("sessions");
  const [scopedId, setScopedId] = useState<string>();
  const scopedWorkspace = docked && tab === "workspaces" && scopedId ? topWorkspace(workspaces, scopedId) : null;
  const scopedSort = useSessionSort(scopedId ?? "");
  const [query, setQuery] = useState("");
  const [railSearch, setRailSearch] = useState(false);
  const list = useRef<FlashListRef<Item>>(null);
  const lastVisibleSelection = useRef<string>(undefined);
  const listKey = scopedWorkspace ? `workspace:${scopedWorkspace.id}` : tab;
  const [androidSearch, setAndroidSearch] = useState(false);
  const actions = useSessionActions();
  const [refreshing, setRefreshing] = useState(false);

  const waitingAgents = useMemo(() => agents.filter((agent) => agent.status === "waiting"), [agents]);
  const waitingIds = JSON.stringify(waitingAgents.map((agent) => agent.id).sort());
  const timelines = useAppState((s) => s.timelines);

  useEffect(() => {
    if (androidSearch) searchBar.current?.focus();
  }, [androidSearch]);

  const refreshWaiting = useCallback(async () => {
    const ids: string[] = JSON.parse(waitingIds);
    await Promise.all(ids.map((id) => store.syncTimeline(id)));
  }, [waitingIds]);

  useEffect(() => {
    if (tab === "waiting" && conn === "online") void refreshWaiting();
  }, [tab, conn, refreshWaiting]);

  const data = useMemo<Item[]>(() => {
    const items: Item[] = [];
    if (scopedWorkspace) {
      const project = buildProject(scopedWorkspace, workspaces, agents, scopedSort);
      const locations = [project.main, ...project.worktrees];
      for (const location of locations) {
        items.push({ kind: "header", key: `location:${location.workspace.id}`, title: location.label, count: location.sessions.length, mark: location.kind === "worktree" ? "worktree" : "folder", workspaceId: null });
        for (const agent of location.sessions) items.push({ kind: "session", key: agent.id, agent, workspace: "" });
      }
      const compare = compareAgents(scopedSort);
      const done = locations.flatMap((location) => location.done.map((agent) => ({ kind: "session" as const, key: agent.id, agent, workspace: location.label })))
        .sort((a, b) => compare(a.agent, b.agent));
      if (done.length) items.push({ kind: "header", key: "location:done", title: "Done", count: done.length, mark: "archive", workspaceId: null }, ...done);
      return items;
    }
    const sections = groupAgents(tab === "waiting" ? waitingAgents : agents, workspaces, query);
    if (tab === "waiting") {
      return sections.flatMap(({ agents }) => agents)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((agent) => ({ kind: "session", key: agent.id, agent, workspace: workspaceName(agent, workspaces) }));
    }
    for (const section of sections) {
      const workspaceId = workspaces.some((workspace) => workspace.id === section.key) ? section.key : null;
      items.push({ kind: "header", key: `h:${section.key}`, title: section.title, count: section.agents.length, mark: section.key === "pinned" ? "pinned" : section.key === "done" ? "archive" : section.key === "chats" ? "chats" : "folder", workspaceId });
      if (collapsed.includes(`h:${section.key}`)) continue;
      for (const agent of section.agents) {
        const workspace = section.key === "pinned" || section.key === "done" ? workspaceName(agent, workspaces) : "";
        items.push({ kind: "session", key: agent.id, agent, workspace });
      }
    }
    return items;
  }, [agents, workspaces, query, tab, waitingAgents, collapsed, scopedWorkspace, scopedSort]);
  const stickyHeaderIndices = useMemo(() => data.flatMap((item, i) => (item.kind === "header" ? [i] : [])), [data]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await store.sync().catch(() => {});
    if (tab === "waiting") await refreshWaiting();
    setRefreshing(false);
  }, [tab, refreshWaiting]);

  const revealSelection = useCallback(() => {
    if (!sessionId) {
      lastVisibleSelection.current = undefined;
      return;
    }
    const selection = JSON.stringify([listKey, sessionId]);
    if (lastVisibleSelection.current === selection || (tab === "workspaces" && !scopedWorkspace)) return;
    const index = data.findIndex((item) => item.kind === "session" && item.key === sessionId);
    if (index < 0 || !list.current) return;
    lastVisibleSelection.current = selection;
    void list.current.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
  }, [data, listKey, sessionId, tab, scopedWorkspace]);

  useEffect(revealSelection, [revealSelection]);

  const open = useCallback((id: string) => {
    if (onOpenSession) {
      lastVisibleSelection.current = JSON.stringify([listKey, id]);
      Keyboard.dismiss();
      onOpenSession(id, tab === "waiting");
    }
    else router.push({ pathname: "/session/[id]", params: tab === "waiting" ? { id, focusQuestion: "1" } : { id } });
  }, [listKey, onOpenSession, router, tab]);
  const searchLabel = tab === "workspaces" ? "Search workspaces" : "Search sessions";

  return (
    <View style={{ flex: 1 }}>
      {docked && scopedWorkspace ? null : docked ? (
        <View>
          <View style={styles.railHeader}>
            <Text color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.appTitle, styles.railTitle]}>Lodestar</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={railSearch ? "Close search" : searchLabel}
              onPress={() => { if (railSearch) setQuery(""); setRailSearch(!railSearch); }} style={styles.headerButton}>
              <Icon name={railSearch ? "xmark" : "magnifyingglass"} size={22} color="textStrong" />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="New session" onPress={() => router.push("/new")} style={styles.headerButton}>
              <Icon name="pencil" size={22} color="textStrong" />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} style={styles.headerButton}>
              <Icon name="gearshape" size={22} color="textStrong" />
            </Pressable>
          </View>
          {railSearch && <TextInput disableFullscreenUI autoFocus accessibilityLabel={searchLabel} placeholder={searchLabel} placeholderTextColor={colors.textMuted}
            value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
            style={[styles.searchInput, { backgroundColor: colors.surface, color: colors.textStrong, borderColor: colors.border }]} />}
        </View>
      ) : <Stack.Screen
        options={{
          headerTitleAlign: "left",
          headerTitle: () => <Text color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.appTitle}>Lodestar</Text>,
          headerSearchBarOptions: Platform.OS !== "android" || androidSearch ? { ref: searchBar, autoFocus: androidSearch, onClose: () => { setQuery(""); setAndroidSearch(false); }, placeholder: searchLabel, onChangeText: (e) => setQuery(e.nativeEvent.text), autoCapitalize: "none", hideWhenScrolling: false, barTintColor: colors.inputBackground, tintColor: colors.accentText, headerIconColor: colors.textStrong, textColor: colors.textStrong, hintTextColor: colors.textMuted, shouldShowHintSearchIcon: false } : undefined,
          headerRight: () => androidSearch ? null : <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={tab === "workspaces" ? "Search workspaces" : "Search sessions"} onPress={() => Platform.OS === "android" ? setAndroidSearch(true) : searchBar.current?.focus()} style={styles.headerButton}>
              <Icon name="magnifyingglass" size={22} color="textStrong" />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} style={styles.headerButton}>
              <Icon name="gearshape" size={22} color="textStrong" />
            </Pressable>
          </View>,
        }}
      />}
      <View style={{ paddingTop: Platform.OS === "ios" ? headerHeight : 0 }}>
        {!docked && <ConnectionBanner />}
        <Segmented options={[{ value: "sessions", label: "Sessions" }, { value: "waiting", label: "Waiting", count: waitingAgents.length, countTone: "attention" }, { value: "workspaces", label: "Workspaces" }]} value={tab} onChange={setTab} paneWidth={paneWidth} />
      </View>
      {scopedWorkspace && (
        <View style={styles.scope}>
          <Button title="Back to workspaces" kind="plain" onPress={() => setScopedId(undefined)} />
          <View style={styles.projectTitle}><ProjectIcon /><Text variant="title" color="textStrong" numberOfLines={2} style={{ flex: 1 }}>{scopedWorkspace.name}</Text></View>
          <Button title="New in workspace" onPress={() => router.push({ pathname: "/new", params: { workspace: scopedWorkspace.id } })} />
        </View>
      )}
      {tab === "workspaces" && !scopedWorkspace ? (
        <WorkspacesView query={query} paneWidth={paneWidth} selectedId={workspaceId} onOpen={docked ? setScopedId : undefined} />
      ) : tab === "waiting" && waitingAgents.length === 0 && loaded && (conn === "online" || agents.length > 0) ? (
        <View style={styles.waitingEmpty}><Icon name="checkmark.circle" size={28} color="textSubtle" /><Text variant="title" color="textStrong" style={{ fontSize: 19 }}>No replies needed</Text><Text variant="secondary" color="textMuted" style={styles.emptyBody}>Questions and approvals from your sessions show up here.</Text></View>
      ) : data.length === 0 ? (
        <Empty offline={conn !== "online" && agents.length === 0} searching={query.trim().length > 0} onNew={() => router.push("/new")} />
      ) : (
        <FlashList
          key={listKey}
          onLoad={revealSelection}
          ref={list}
          data={data}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          stickyHeaderIndices={stickyHeaderIndices}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps={docked ? "handled" : undefined}
          contentContainerStyle={{ paddingBottom: docked ? spacing.xl : NEW_SESSION_CLEARANCE }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textMuted} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
          extraData={tab === "waiting" ? { timelines, sessionId } : sessionId}
          renderItem={({ item }) => {
            if (item.kind === "header") {
              if (scopedWorkspace) return (
                <View style={[styles.sectionHeader, styles.scope, { backgroundColor: colors.background }]}>
                  <ProjectIcon mark={item.mark} />
                  <Text variant="secondary" color="textStrong" style={styles.sectionTitle} numberOfLines={1}>{item.title}</Text>
                  <Text variant="caption" color="textSubtle">{item.count}</Text>
                </View>
              );
              const { workspaceId } = item;
              return <SectionHeader title={item.title} count={item.count} mark={item.mark}
                expanded={!collapsed.includes(item.key)}
                onToggle={() => sortPrefs.toggleGroup(item.key)}
                onNew={workspaceId ? () => router.push({ pathname: "/new", params: { workspace: workspaceId } }) : undefined} />;
            }
            if (tab === "waiting") {
              const pending = timelines[item.agent.id]?.items.findLast((entry): entry is Extract<TimelineItem, { kind: "permission" }> => entry.kind === "permission" && entry.status === "pending");
              return <WaitingRow agent={item.agent} selected={docked ? sessionId === item.agent.id : undefined} workspace={item.workspace} pending={pending} onPress={open} onLongPress={actions.open} />;
            }
            return <SessionRow agent={item.agent} selected={docked ? sessionId === item.agent.id : undefined} subtitle={item.workspace} time={scopedWorkspace ? scopedSort : undefined} onPress={open} onLongPress={actions.open} />;
          }}
        />
      )}
      {!docked && tab !== "workspaces" && <NewSessionButton onPress={() => router.push("/new")} />}
      <RenameDialog initial={actions.renaming?.title ?? null} onSubmit={actions.submitRename} onClose={actions.closeRename} />
    </View>
  );
}

const SectionHeader = memo(function SectionHeader({ title, count, mark, expanded, onToggle, onNew }: {
  title: string; count: number; mark: ProjectMark; expanded: boolean; onToggle: () => void; onNew?: () => void;
}) {
  const colors = useColors();
  return (
    <View style={[styles.sectionHeader, { backgroundColor: colors.background }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onToggle} style={styles.sectionToggle}>
        <View style={styles.sectionLane}><Icon name={expanded ? "chevron.down" : "chevron.right"} size={18} color="textSubtle" /></View>
        <View style={styles.sectionMark}><ProjectIcon mark={mark} /></View>
        <Text variant="secondary" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={18 / 14} style={styles.sectionTitle}>{title}</Text>
        <Text variant="caption" color="textSubtle" style={styles.sectionCount}>{count}</Text>
      </Pressable>
      {onNew && <Pressable accessibilityRole="button" accessibilityLabel={`New session in ${title}`} onPress={onNew} style={styles.headerButton}>
        <Icon name="plus" size={22} color="textMuted" />
      </Pressable>}
    </View>
  );
});

function WaitingRow({ agent, selected, workspace, pending, onPress, onLongPress }: {
  agent: Agent; selected?: boolean; workspace: string; pending?: Extract<TimelineItem, { kind: "permission" }>;
  onPress: (id: string) => void; onLongPress: (agent: Agent) => void;
}) {
  const questions = pending?.toolName === QUESTION_TOOL ? readQuestions(pending.input) : [];
  const plan = pending?.toolName === PLAN_TOOL;
  const target = pending && !questions.length && !plan ? approvalTarget(pending.toolName, pending.input) : null;
  const verb = pending && describeTool(pending.toolName, pending.input, false).verb;
  const kind = pending && (pending.toolName === QUESTION_TOOL ? "Question" : plan ? "Plan" : "Approval");
  const request = questions[0]?.question ?? (plan ? "Plan ready for review" : target ? `${verb} ${target.text}` : verb);
  return <SessionRowFrame detailsLabel={[kind, request, workspace].filter(Boolean).join(", ")} agent={agent} selected={selected} state="waiting" stamp={relativeTime(agent.updatedAt)} emphasized onPress={onPress} onLongPress={onLongPress}>
    {pending && <Text variant="secondary" numberOfLines={2} style={{ marginVertical: 2 }}>
      {questions[0]?.question ?? (plan ? "Plan ready for review" : target?.kind === "command"
        ? <>Run <Text variant="mono">{target.text}</Text></>
        : target ? `${verb} ${target.text}` : verb)}
    </Text>}
    <Text variant="secondary" color="textMuted" numberOfLines={2} maxFontSizeMultiplier={18 / 14}>
      {kind && <Text variant="secondary" color="warning" maxFontSizeMultiplier={18 / 14} style={{ fontWeight: "600" }}>{kind}</Text>}
      {kind ? " · " : ""}{workspace}{questions.length > 1 ? ` · ${questions.length} questions` : ""}
    </Text>
  </SessionRowFrame>;
}

function Empty({ offline, searching, onNew }: { offline: boolean; searching: boolean; onNew: () => void }) {
  return (
    <View style={styles.empty}>
      <Text variant="title" color="textStrong">{offline ? "No saved sessions" : searching ? "No matching sessions" : "No sessions yet"}</Text>
      {!offline && !searching && <Button title="Start a session" kind="primary" onPress={onNew} />}
    </View>
  );
}

const styles = StyleSheet.create({
  projectTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
  scope: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  railHeader: { minHeight: 56, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: spacing.lg },
  railTitle: { flex: 1 },
  searchInput: { marginHorizontal: spacing.md, marginBottom: spacing.sm, paddingHorizontal: spacing.md, minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm },
  headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row" },
  appTitle: { fontSize: 20, lineHeight: 26, fontWeight: "600" },
  sectionHeader: { flexDirection: "row", alignItems: "center", minHeight: 48 },
  sectionToggle: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", paddingHorizontal: 16 },
  sectionMark: { marginRight: 8 },
  sectionLane: { width: 20, marginRight: 12, alignItems: "center" },
  sectionTitle: { fontWeight: "600", flexShrink: 1 },
  sectionCount: { marginLeft: 8, fontVariant: ["tabular-nums"] },
  waitingEmpty: { flex: 1, alignItems: "center", paddingTop: 72, gap: spacing.md, paddingHorizontal: 16 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  emptyBody: { textAlign: "center", maxWidth: 280 },
});
