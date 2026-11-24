import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Stack, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, PanResponder, Platform, Pressable, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Agent, TimelineItem } from "@shared/protocol";
import { groupAgents, workspaceName } from "../logic/agents";
import { buildProject, compareAgents, topWorkspace } from "../logic/workspaces";
import { readQuestions, PLAN_TOOL, QUESTION_TOOL } from "../logic/questions";
import { approvalTarget, describeTool } from "../logic/tools";
import { sortPrefs, store, useAppState, useSessionSort, useSortPrefs } from "../state/app";
import { radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { ProjectIcon, type ProjectMark } from "./ProjectIcon";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { ConnectionTitle } from "./ConnectionTitle";
import { Icon } from "./Icon";
import { RenameDialog } from "./RenameDialog";
import { Segmented } from "./Segmented";
import { rowSwipeGate, SessionRow, SessionRowFrame } from "./SessionRow";
import { ProviderLabel } from "./ProviderMark";
import { MenuButton, SESSION_SORT_OPTIONS, SortButton } from "./SortButton";
import type { ListView } from "../state/sortPrefs";
import { relativeTime } from "../logic/time";
import { Text } from "./Text";
import { useSessionActions } from "./sessionActions";
import { armSplitDrag } from "./SplitDrag";
import type { ActionChoice } from "./actionMenu";
import { NEW_SESSION_CLEARANCE, NewSessionButton } from "./NewSessionButton";
import { WorkspacesView } from "./WorkspacesView";

type Item = { kind: "header"; key: string; title: string; count: number; mark: ProjectMark; workspaceId: string | null; first: boolean } | { kind: "session"; key: string; agent: Agent; workspace: string };
const GROUPING_OPTIONS = [{ value: "workspace", label: "Workspace" }, { value: "time", label: "Time" }] as const;
const tabs = ["sessions", "waiting", "workspaces"] as const;
type Tab = (typeof tabs)[number];

export function SessionsList({ docked = false, paneWidth, sessionId, workspaceId, onOpenSession, splitChoices, headerHeight = 0 }: {
  docked?: boolean;
  paneWidth?: number;
  sessionId?: string;
  workspaceId?: string;
  onOpenSession?: (id: string, focusQuestion: boolean) => void;
  splitChoices?: (agent: Agent) => ActionChoice[];
  headerHeight?: number;
}) {
  const router = useRouter();
  const colors = useColors();
  const agents = useAppState((s) => s.agents);
  const workspaces = useAppState((s) => s.workspaces);
  const conn = useAppState((s) => s.conn);
  const loaded = useAppState((s) => s.loaded);
  const { collapsed, list: view } = useSortPrefs();
  const searchBar = useRef<SearchBarCommands>(null);
  const [tab, setTab] = useState<Tab>("sessions");
  const [scopedId, setScopedId] = useState<string>();
  const scopedWorkspace = docked && tab === "workspaces" && scopedId ? topWorkspace(workspaces, scopedId) : null;
  const swipe = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) =>
      !rowSwipeGate.claimed && gesture.numberActiveTouches === 1 && Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > 1.6 * Math.abs(gesture.dy),
    onPanResponderRelease: (_, { dx, dy, vx }) => {
      if (Math.abs(dx) <= Math.abs(dy) * 1.4 || (Math.abs(dx) < 48 && !(Math.abs(dx) > 22 && Math.abs(vx) > 0.45))) return;
      setTab((current) => tabs[tabs.indexOf(current) + (dx < 0 ? 1 : -1)] ?? current);
    },
  }), []);
  const scopedSort = useSessionSort(scopedWorkspace?.id ?? "");
  const [query, setQuery] = useState("");
  const [railSearch, setRailSearch] = useState(false);
  const list = useRef<FlashListRef<Item>>(null);
  const lastVisibleSelection = useRef<string>(undefined);
  const listKey = scopedWorkspace ? `workspace:${scopedWorkspace.id}` : tab;
  const ownHeader = docked || Platform.OS === "android";
  const insets = useSafeAreaInsets();
  const actions = useSessionActions();
  const { open: openActions } = actions;
  const longPress = useCallback((agent: Agent) => {
    const menu = () => openActions(agent, { leading: splitChoices?.(agent) });
    if (docked) armSplitDrag({ agentId: agent.id, title: agent.title }, menu);
    else menu();
  }, [docked, openActions, splitChoices]);
  const [refreshing, setRefreshing] = useState(false);

  const waitingAgents = useMemo(() => agents.filter((agent) => agent.status === "waiting"), [agents]);
  const waitingIds = JSON.stringify(waitingAgents.map((agent) => agent.id).sort());
  const timelines = useAppState((s) => s.timelines);

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
        items.push({ kind: "header", key: `location:${location.workspace.id}`, title: location.label, count: location.sessions.length, mark: location.kind === "worktree" ? "worktree" : "folder", workspaceId: null, first: items.length === 0 });
        for (const agent of location.sessions) items.push({ kind: "session", key: agent.id, agent, workspace: "" });
      }
      const compare = compareAgents(scopedSort);
      const done = locations.flatMap((location) => location.done.map((agent) => ({ kind: "session" as const, key: agent.id, agent, workspace: location.label })))
        .sort((a, b) => compare(a.agent, b.agent));
      if (done.length) items.push({ kind: "header", key: "location:done", title: "Done", count: done.length, mark: "archive", workspaceId: null, first: items.length === 0 }, ...done);
      return items;
    }
    const sections = groupAgents(tab === "waiting" ? waitingAgents : agents, workspaces, query, view);
    if (tab === "waiting") {
      return sections.flatMap(({ agents }) => agents)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((agent) => ({ kind: "session", key: agent.id, agent, workspace: workspaceName(agent, workspaces) }));
    }
    for (const section of sections) {
      const workspaceId = section.kind === "workspace" && workspaces.some((workspace) => workspace.id === section.key) ? section.key : null;
      items.push({ kind: "header", key: `h:${section.key}`, title: section.title, count: section.agents.length, mark: section.kind === "pinned" ? "pinned" : section.kind === "done" ? "archive" : section.kind === "chats" ? "chats" : "folder", workspaceId, first: items.length === 0 });
      if (collapsed.includes(`h:${section.key}`)) continue;
      for (const agent of section.agents) {
        const workspace = section.kind === "workspace" || section.kind === "chats" ? "" : workspaceName(agent, workspaces);
        items.push({ kind: "session", key: agent.id, agent, workspace });
      }
    }
    return items;
  }, [agents, workspaces, query, tab, waitingAgents, collapsed, scopedWorkspace, scopedSort, view]);
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
  const viewMenu = tab === "sessions" && !scopedWorkspace ? <ViewMenu view={view} /> : null;
  const appTitle = (size: number) => <View style={styles.brand}>
    <BrandMark />
    <Text accessibilityRole="header" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={size} style={styles.appTitle}>Lodestar</Text>
  </View>;

  return (
    <View style={{ flex: 1 }}>
      {docked && scopedWorkspace ? null : ownHeader ? (
        <View style={docked ? undefined : { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
          <View style={styles.railHeader}>
            <ConnectionTitle title="Lodestar" style={styles.railTitle}>
              {appTitle(1.2)}
            </ConnectionTitle>
            {viewMenu}
            <Pressable accessibilityRole="button" accessibilityLabel={railSearch ? "Close search" : searchLabel}
              onPress={() => { if (railSearch) setQuery(""); setRailSearch(!railSearch); }} style={styles.headerButton}>
              <Icon name={railSearch ? "xmark" : "magnifyingglass"} size={20} color="textStrong" />
            </Pressable>
            {docked && <Pressable accessibilityRole="button" accessibilityLabel="New session" onPress={() => router.push("/new")} style={styles.headerButton}>
              <Icon name="pencil" size={20} color="textStrong" />
            </Pressable>}
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} style={styles.headerButton}>
              <Icon name="gearshape" size={20} color="textStrong" />
            </Pressable>
          </View>
          {railSearch && <TextInput disableFullscreenUI autoFocus accessibilityLabel={searchLabel} placeholder={searchLabel} placeholderTextColor={colors.textMuted}
            value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
            style={[styles.searchInput, { backgroundColor: colors.surface, color: colors.textStrong, borderColor: colors.border }]} />}
        </View>
      ) : <Stack.Screen
        options={{
          headerTitleAlign: "left",
          headerLeft: () => <View style={styles.brandSlot}><BrandMark /></View>,
          headerTitle: () => <ConnectionTitle title="Lodestar" maxFontSizeMultiplier={1.1}>
            <Text accessibilityRole="header" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.1} style={styles.appTitle}>Lodestar</Text>
          </ConnectionTitle>,
          headerSearchBarOptions: { ref: searchBar, onClose: () => setQuery(""), placeholder: searchLabel, onChangeText: (e) => setQuery(e.nativeEvent.text), autoCapitalize: "none", hideWhenScrolling: false, barTintColor: colors.inputBackground, tintColor: colors.accentText, headerIconColor: colors.textStrong, textColor: colors.textStrong, hintTextColor: colors.textMuted, shouldShowHintSearchIcon: false },
          headerRight: () => <View style={styles.headerActions}>
            {viewMenu}
            <Pressable accessibilityRole="button" accessibilityLabel={tab === "workspaces" ? "Search workspaces" : "Search sessions"} onPress={() => searchBar.current?.focus()} style={styles.headerButton}>
              <Icon name="magnifyingglass" size={20} color="textStrong" />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} style={styles.headerButton}>
              <Icon name="gearshape" size={20} color="textStrong" />
            </Pressable>
          </View>,
        }}
      />}
      <View style={styles.tabContent} {...swipe.panHandlers} onTouchEnd={releaseRowSwipe} onTouchCancel={releaseRowSwipe}>
        <View style={{ paddingTop: Platform.OS === "ios" ? headerHeight : 0 }}>
          <Segmented underline options={[{ value: "sessions", label: "Sessions" }, { value: "waiting", label: "Waiting", count: waitingAgents.length, countTone: "attention" }, { value: "workspaces", label: "Workspaces" }]} value={tab} onChange={setTab} paneWidth={paneWidth} />
        </View>
        {scopedWorkspace && (
          <View style={styles.scope}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back to workspaces" style={styles.headerButton} onPress={() => setScopedId(undefined)}>
              <Icon name="chevron.left" size={20} color="textMuted" />
            </Pressable>
            <ConnectionTitle title={scopedWorkspace.name} style={styles.railTitle}>
              <View style={styles.projectTitle}>
                <WorkspaceIcon workspaceId={scopedWorkspace.id} size={18} fallback={<ProjectIcon />} />
                <Text accessibilityRole="header" variant="bodyStrong" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.railTitle}>{scopedWorkspace.name}</Text>
              </View>
            </ConnectionTitle>
            <SortButton label="Sort sessions" value={scopedSort} options={SESSION_SORT_OPTIONS} onChange={(next) => sortPrefs.setSessionSort(scopedWorkspace.id, next)} />
            <Pressable accessibilityRole="button" accessibilityLabel="New in workspace" style={styles.headerButton} onPress={() => router.push({ pathname: "/new", params: { workspace: scopedWorkspace.id } })}>
              <Icon name="plus" size={20} color="textMuted" />
            </Pressable>
          </View>
        )}
        {tab === "workspaces" && !scopedWorkspace ? (
          <WorkspacesView query={query} selectedId={workspaceId} onOpen={docked ? setScopedId : undefined} />
        ) : tab === "waiting" && waitingAgents.length === 0 && loaded && (conn === "online" || agents.length > 0) ? (
          <View style={styles.waitingEmpty}><Icon name="checkmark.circle" size={28} color="textSubtle" /><Text variant="title" color="textStrong" style={{ fontSize: 19 }}>No replies needed</Text></View>
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
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void refresh()}
                progressViewOffset={Platform.OS === "android" && stickyHeaderIndices.length ? SECTION_HEADER_HEIGHT : 0}
                tintColor={colors.textMuted}
                colors={[colors.accent]}
                progressBackgroundColor={colors.surface}
              />
            }
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
                return <SectionHeader title={item.title} count={item.count} first={item.first} workspaceId={workspaceId}
                  expanded={!collapsed.includes(item.key)}
                  onToggle={() => sortPrefs.toggleGroup(item.key)}
                  onNew={workspaceId ? () => router.push({ pathname: "/new", params: { workspace: workspaceId } }) : undefined} />;
              }
              if (tab === "waiting") {
                const pending = timelines[item.agent.id]?.items.findLast((entry): entry is Extract<TimelineItem, { kind: "permission" }> => entry.kind === "permission" && entry.status === "pending");
                return <WaitingRow agent={item.agent} selected={docked ? sessionId === item.agent.id : undefined} workspace={item.workspace} pending={pending} onPress={open} onLongPress={longPress} />;
              }
              return <SessionRow agent={item.agent} selected={docked ? sessionId === item.agent.id : undefined} subtitle={item.workspace} time={scopedWorkspace ? scopedSort : view.ordering} onPress={open} onLongPress={longPress} />;
            }}
          />
        )}
      </View>
      {!docked && tab !== "workspaces" && <NewSessionButton onPress={() => router.push("/new")} />}
      <RenameDialog initial={actions.renaming?.title ?? null} onSubmit={actions.submitRename} onClose={actions.closeRename} />
    </View>
  );
}

const SectionHeader = memo(function SectionHeader({ title, count, first, workspaceId, expanded, onToggle, onNew }: {
  title: string; count: number; first: boolean; workspaceId: string | null; expanded: boolean; onToggle: () => void; onNew?: () => void;
}) {
  const colors = useColors();
  return (
    <View style={[styles.sectionHeader, { backgroundColor: colors.background, paddingTop: first ? 0 : spacing.sm }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${title}, ${count} ${count === 1 ? "session" : "sessions"}`} accessibilityState={{ expanded }} onPress={onToggle} style={styles.sectionToggle}>
        <WorkspaceIcon workspaceId={workspaceId} size={20} />
        <Text variant="secondary" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.25} style={styles.sectionTitle}>{title}</Text>
        {!expanded && <Text variant="secondary" color="textSubtle" maxFontSizeMultiplier={1.25} style={styles.sectionCount}>{count}</Text>}
        <Icon name={expanded ? "chevron.down" : "chevron.right"} size={14} color="textSubtle" />
      </Pressable>
      {onNew && <Pressable accessibilityRole="button" accessibilityLabel={`New session in ${title}`} onPress={onNew} style={styles.sectionNew}>
        <Icon name="plus" size={18} color="textMuted" />
      </Pressable>}
    </View>
  );
});

function BrandMark() {
  const colors = useColors();
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={styles.brandMark}>
    <View style={[styles.rayUp, { borderBottomColor: colors.accent }]} />
    <View style={[styles.rayDown, { borderTopColor: colors.accent }]} />
    <View style={[styles.rayLeft, { borderRightColor: colors.accent }]} />
    <View style={[styles.rayRight, { borderLeftColor: colors.accent }]} />
  </View>;
}

function ViewMenu({ view }: { view: ListView }) {
  return <MenuButton label="View options" icon="line.3.horizontal.decrease"
    valueText={`${view.grouping === "time" ? "Time" : "Workspace"}, ${view.ordering === "created" ? "Created" : "Updated"}`}
    sections={[
      { title: "Grouping", value: view.grouping, options: GROUPING_OPTIONS, onChange: (grouping) => sortPrefs.setListView({ grouping: grouping === "time" ? "time" : "workspace" }) },
      { title: "Ordering", value: view.ordering, options: SESSION_SORT_OPTIONS, onChange: (ordering) => sortPrefs.setListView({ ordering: ordering === "created" ? "created" : "updated" }) },
    ]} />;
}

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
  const context = [workspace, questions.length > 1 ? `${questions.length} questions` : null].filter(Boolean).join(" · ");
  return <SessionRowFrame detailsLabel={[kind, request, workspace].filter(Boolean).join(", ")} agent={agent} selected={selected} state="waiting" stamp={relativeTime(agent.updatedAt)} emphasized onPress={onPress} onLongPress={onLongPress}>
    {!!request && <Text variant="secondary" color="textStrong" numberOfLines={2}>{request}</Text>}
    <ProviderLabel workspaceId={workspace ? agent.workspaceId : null} parts={[context]} />
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

function releaseRowSwipe() {
  rowSwipeGate.claimed = false;
}

const SECTION_HEADER_HEIGHT = 48;
const BRAND_SIZE = 26;
const BRAND_HALF = BRAND_SIZE / 2;
const RAY_BASE = 5;

const styles = StyleSheet.create({
  tabContent: { flex: 1 },
  projectTitle: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  scope: { flexDirection: "row", alignItems: "center" },
  railHeader: { minHeight: 48, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: spacing.lg },
  railTitle: { flex: 1, minWidth: 0 },
  searchInput: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: spacing.md, minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm },
  headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row" },
  appTitle: { fontSize: 20, lineHeight: 24, fontWeight: "600", flexShrink: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
  brandMark: { width: BRAND_SIZE, height: BRAND_SIZE },
  rayUp: { position: "absolute", left: BRAND_HALF - RAY_BASE, top: 0, borderLeftWidth: RAY_BASE, borderRightWidth: RAY_BASE, borderBottomWidth: BRAND_HALF, borderLeftColor: "transparent", borderRightColor: "transparent" },
  rayDown: { position: "absolute", left: BRAND_HALF - RAY_BASE, top: BRAND_HALF, borderLeftWidth: RAY_BASE, borderRightWidth: RAY_BASE, borderTopWidth: BRAND_HALF, borderLeftColor: "transparent", borderRightColor: "transparent" },
  rayLeft: { position: "absolute", left: 0, top: BRAND_HALF - RAY_BASE, borderTopWidth: RAY_BASE, borderBottomWidth: RAY_BASE, borderRightWidth: BRAND_HALF, borderTopColor: "transparent", borderBottomColor: "transparent" },
  rayRight: { position: "absolute", left: BRAND_HALF, top: BRAND_HALF - RAY_BASE, borderTopWidth: RAY_BASE, borderBottomWidth: RAY_BASE, borderLeftWidth: BRAND_HALF, borderTopColor: "transparent", borderBottomColor: "transparent" },
  brandSlot: { width: 26, height: 26, marginRight: 10 },
  sectionHeader: { flexDirection: "row", alignItems: "center", paddingLeft: spacing.lg, paddingRight: spacing.xs },
  sectionToggle: { flex: 1, minWidth: 0, minHeight: SECTION_HEADER_HEIGHT, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sectionTitle: { fontSize: 17, lineHeight: 22, fontWeight: "700", flexShrink: 1 },
  sectionCount: { fontSize: 15, lineHeight: 22, fontVariant: ["tabular-nums"] },
  sectionNew: { width: 44, height: SECTION_HEADER_HEIGHT, alignItems: "center", justifyContent: "center" },
  waitingEmpty: { flex: 1, alignItems: "center", paddingTop: 72, gap: spacing.md, paddingHorizontal: 16 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
});
