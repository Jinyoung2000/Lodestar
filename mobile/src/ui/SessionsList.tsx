import { MateRow } from "./mate/MateRow";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Stack, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Agent } from "@shared/protocol";
import { groupAgents, workspaceName } from "../logic/agents";
import { sortPrefs, store, useAppState, useSortPrefs } from "../state/app";
import { radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import type { ProjectMark } from "./ProjectIcon";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { ConnectionTitle } from "./ConnectionTitle";
import { Icon } from "./Icon";
import { RenameDialog } from "./RenameDialog";
import { ROW_INSET, SessionRow } from "./SessionRow";
import { MenuButton, SESSION_SORT_OPTIONS } from "./SortButton";
import type { ListView } from "../state/sortPrefs";
import { Text } from "./Text";
import { useSessionActions } from "./sessionActions";
import { armSplitDrag } from "./SplitDrag";
import type { ActionChoice } from "./actionMenu";
import { NEW_SESSION_CLEARANCE, NewSessionButton } from "./NewSessionButton";

type Item = { kind: "header"; key: string; title: string; count: number; mark: ProjectMark; workspaceId: string | null; first: boolean } | { kind: "session"; key: string; agent: Agent; workspace: string };
const GROUPING_OPTIONS = [{ value: "workspace", label: "Workspace" }, { value: "time", label: "Time" }] as const;

export function SessionsList({ docked = false, sessionId, onOpenSession, splitChoices, onHide, headerHeight = 0 }: {
  docked?: boolean;
  onHide?: () => void;
  sessionId?: string;
  onOpenSession?: (id: string, focusQuestion: boolean) => void;
  splitChoices?: (agent: Agent) => ActionChoice[];
  headerHeight?: number;
}) {
  const router = useRouter();
  const colors = useColors();
  const everyAgent = useAppState((s) => s.agents);
  const agents = useMemo(() => everyAgent.filter((agent) => !agent.assistant && !agent.automationId), [everyAgent]);
  const workspaces = useAppState((s) => s.workspaces);
  const conn = useAppState((s) => s.conn);
  const { collapsed, list: view } = useSortPrefs();
  const searchBar = useRef<SearchBarCommands>(null);
  const [query, setQuery] = useState("");
  const [railSearch, setRailSearch] = useState(false);
  const list = useRef<FlashListRef<Item>>(null);
  const lastVisibleSelection = useRef<string>(undefined);
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

  const data = useMemo<Item[]>(() => {
    const items: Item[] = [];
    const sections = groupAgents(agents, workspaces, query, view);
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
  }, [agents, workspaces, query, collapsed, view]);
  const stickyHeaderIndices = useMemo(() => data.flatMap((item, i) => (item.kind === "header" ? [i] : [])), [data]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await store.sync().catch(() => {});
    setRefreshing(false);
  }, []);

  const revealSelection = useCallback(() => {
    if (!sessionId) {
      lastVisibleSelection.current = undefined;
      return;
    }
    if (lastVisibleSelection.current === sessionId) return;
    const index = data.findIndex((item) => item.kind === "session" && item.key === sessionId);
    if (index < 0 || !list.current) return;
    lastVisibleSelection.current = sessionId;
    void list.current.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
  }, [data, sessionId]);

  useEffect(revealSelection, [revealSelection]);

  const open = useCallback((id: string) => {
    if (onOpenSession) {
      lastVisibleSelection.current = id;
      Keyboard.dismiss();
      onOpenSession(id, false);
    }
    else router.push({ pathname: "/session/[id]", params: { id } });
  }, [onOpenSession, router]);
  const searchLabel = "Search sessions";
  const viewMenu = <ViewMenu view={view} />;

  return (
    <View style={{ flex: 1 }}>
      {ownHeader ? (
        <View style={docked ? undefined : { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
          <View style={[styles.railHeader, onHide && styles.railHeaderWithHide]}>
            {onHide && <Pressable accessibilityRole="button" accessibilityLabel="Hide sidebar" onPress={onHide} style={styles.headerButton}>
              <Icon name="line.3.horizontal" size={20} color="textStrong" />
            </Pressable>}
            <ConnectionTitle title="Lodestar" style={styles.railTitle}>
              <RailBrand />
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
            <Pressable accessibilityRole="button" accessibilityLabel={searchLabel} onPress={() => searchBar.current?.focus()} style={styles.headerButton}>
              <Icon name="magnifyingglass" size={20} color="textStrong" />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} style={styles.headerButton}>
              <Icon name="gearshape" size={20} color="textStrong" />
            </Pressable>
          </View>,
        }}
      />}
      <View style={styles.fill}>
        <View style={{ paddingTop: Platform.OS === "ios" ? headerHeight : 0 }}>
          <MateRow onPress={() => router.push("/mate")} />
        </View>
        {data.length === 0 ? (
          <Empty offline={conn !== "online" && agents.length === 0} searching={query.trim().length > 0} onNew={() => router.push("/new")} />
        ) : (
          <FlashList
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
            extraData={sessionId}
            renderItem={({ item }) => {
              if (item.kind === "header") {
                const { workspaceId } = item;
                return <SectionHeader title={item.title} count={item.count} first={item.first} workspaceId={workspaceId}
                  expanded={!collapsed.includes(item.key)}
                  onToggle={() => sortPrefs.toggleGroup(item.key)}
                  onNew={workspaceId ? () => router.push({ pathname: "/new", params: { workspace: workspaceId } }) : undefined} />;
              }
              return <SessionRow agent={item.agent} selected={docked ? sessionId === item.agent.id : undefined} subtitle={item.workspace} time={view.ordering} onPress={open} onLongPress={longPress} />;
            }}
          />
        )}
      </View>
      {!docked && <NewSessionButton onPress={() => router.push("/new")} />}
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

function RailBrand() {
  const [room, setRoom] = useState(0);
  const [wordWidth, setWordWidth] = useState(0);
  const wordFits = !room || !wordWidth || room >= BRAND_SIZE + BRAND_GAP + wordWidth;
  return <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)} style={styles.brandRoom}>
    <View accessible={!wordFits} accessibilityRole="header" accessibilityLabel="Lodestar" style={styles.brand}>
      <BrandMark />
      {wordFits && <Text accessibilityRole="header" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.appTitle}>Lodestar</Text>}
    </View>
    <View accessible={false} importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.wordProbe}>
      <Text onLayout={(e) => setWordWidth(Math.ceil(e.nativeEvent.layout.width))} maxFontSizeMultiplier={1.2} style={styles.appTitle}>Lodestar</Text>
    </View>
  </View>;
}

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

function Empty({ offline, searching, onNew }: { offline: boolean; searching: boolean; onNew: () => void }) {
  return (
    <View style={styles.empty}>
      <Text variant="title" color="textStrong">{offline ? "No saved sessions" : searching ? "No matching sessions" : "No sessions yet"}</Text>
      {!offline && !searching && <Button title="Start a session" kind="primary" onPress={onNew} />}
    </View>
  );
}

const SECTION_HEADER_HEIGHT = 48;
const BRAND_SIZE = 26;
const BRAND_HALF = BRAND_SIZE / 2;
const BRAND_GAP = 10;
const RAY_BASE = 5;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  railHeader: { minHeight: 48, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: spacing.lg },
  railHeaderWithHide: { paddingLeft: 0 },
  railTitle: { flex: 1, minWidth: 0 },
  searchInput: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: spacing.md, minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm },
  headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row" },
  appTitle: { fontSize: 20, lineHeight: 24, fontWeight: "600", flexShrink: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: BRAND_GAP, minWidth: 0 },
  brandRoom: { alignSelf: "stretch", minWidth: 0 },
  wordProbe: { position: "absolute", left: 0, top: 0, width: 400, flexDirection: "row", alignItems: "flex-start", opacity: 0 },
  brandMark: { width: BRAND_SIZE, height: BRAND_SIZE },
  rayUp: { position: "absolute", left: BRAND_HALF - RAY_BASE, top: 0, borderLeftWidth: RAY_BASE, borderRightWidth: RAY_BASE, borderBottomWidth: BRAND_HALF, borderLeftColor: "transparent", borderRightColor: "transparent" },
  rayDown: { position: "absolute", left: BRAND_HALF - RAY_BASE, top: BRAND_HALF, borderLeftWidth: RAY_BASE, borderRightWidth: RAY_BASE, borderTopWidth: BRAND_HALF, borderLeftColor: "transparent", borderRightColor: "transparent" },
  rayLeft: { position: "absolute", left: 0, top: BRAND_HALF - RAY_BASE, borderTopWidth: RAY_BASE, borderBottomWidth: RAY_BASE, borderRightWidth: BRAND_HALF, borderTopColor: "transparent", borderBottomColor: "transparent" },
  rayRight: { position: "absolute", left: BRAND_HALF, top: BRAND_HALF - RAY_BASE, borderTopWidth: RAY_BASE, borderBottomWidth: RAY_BASE, borderLeftWidth: BRAND_HALF, borderTopColor: "transparent", borderBottomColor: "transparent" },
  brandSlot: { width: 26, height: 26, marginRight: 10 },
  sectionHeader: { flexDirection: "row", alignItems: "center", paddingLeft: ROW_INSET, paddingRight: spacing.xs },
  sectionToggle: { flex: 1, minWidth: 0, minHeight: SECTION_HEADER_HEIGHT, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sectionTitle: { fontSize: 17, lineHeight: 22, fontWeight: "700", flexShrink: 1 },
  sectionCount: { fontSize: 15, lineHeight: 22, fontVariant: ["tabular-nums"] },
  sectionNew: { width: 44, height: SECTION_HEADER_HEIGHT, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
});
