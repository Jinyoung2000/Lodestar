import { FlashList } from "@shopify/flash-list";
import { Redirect, Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { memo, useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import type { Agent } from "@shared/protocol";
import { groupAgents, waitingCount, workspaceName } from "../logic/agents";
import { store, useAppState, useConnection } from "../state/app";
import { MIN_TOUCH, spacing, useColors } from "../theme/theme";
import { Button } from "../ui/Button";
import { ConnectionBanner } from "../ui/Banner";
import { Icon } from "../ui/Icon";
import { RenameDialog } from "../ui/RenameDialog";
import { Segmented } from "../ui/Segmented";
import { SessionRow } from "../ui/SessionRow";
import { StatusDot } from "../ui/StatusDot";
import { Text } from "../ui/Text";
import { useSessionActions } from "../ui/sessionActions";
import { WorkspacesView } from "../ui/WorkspacesView";

type Item = { kind: "header"; key: string; title: string; count: number; workspaceId: string | null } | { kind: "session"; key: string; agent: Agent; workspace: string };
type Tab = "sessions" | "workspaces";

export default function Sessions() {
  const router = useRouter();
  const colors = useColors();
  const { connection, bootstrapped } = useConnection();
  const agents = useAppState((s) => s.agents);
  const workspaces = useAppState((s) => s.workspaces);
  const conn = useAppState((s) => s.conn);
  const loaded = useAppState((s) => s.loaded);
  const hostName = useAppState((s) => s.hostName);
  const [tab, setTab] = useState<Tab>("sessions");
  const [query, setQuery] = useState("");
  const actions = useSessionActions();
  const headerHeight = useHeaderHeight();
  const [refreshing, setRefreshing] = useState(false);

  const data = useMemo<Item[]>(() => {
    const items: Item[] = [];
    for (const section of groupAgents(agents, workspaces, query)) {
      items.push({ kind: "header", key: `h:${section.key}`, title: section.title, count: section.agents.length, workspaceId: ["pinned", "chats", "done"].includes(section.key) ? null : section.key });
      for (const agent of section.agents) items.push({ kind: "session", key: agent.id, agent, workspace: workspaceName(agent, workspaces) });
    }
    return items;
  }, [agents, workspaces, query]);
  const stickyHeaderIndices = useMemo(() => data.flatMap((item, i) => (item.kind === "header" ? [i] : [])), [data]);
  const waiting = waitingCount(agents);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await store.sync().catch(() => {});
    setRefreshing(false);
  }, []);

  const open = useCallback((id: string) => router.push({ pathname: "/session/[id]", params: { id } }), [router]);

  if (!bootstrapped) return <View style={{ flex: 1 }} />;
  if (!connection) return <Redirect href="/connect" />;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerSearchBarOptions: { placeholder: tab === "sessions" ? "Search sessions" : "Search workspaces", onChangeText: (e) => setQuery(e.nativeEvent.text), autoCapitalize: "none", hideWhenScrolling: false, headerIconColor: colors.textStrong, textColor: colors.textStrong, hintTextColor: colors.textSubtle, shouldShowHintSearchIcon: false },
          headerLeft: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" hitSlop={8} onPress={() => router.push("/settings")} style={styles.headerButton}>
              <Icon name="gearshape" size={22} color="accentText" />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="New session" hitSlop={8} onPress={() => router.push("/new")} style={styles.headerButton}>
              <Icon name="square.and.pencil" size={22} color="accentText" />
            </Pressable>
          ),
        }}
      />
      <ConnectionBanner status={conn} hostName={hostName} onRepair={() => router.replace("/connect")} />
      <View style={{ paddingTop: Platform.OS === "ios" ? headerHeight : 0 }}>
        <Segmented options={[{ value: "sessions", label: "Sessions" }, { value: "workspaces", label: "Workspaces" }]} value={tab} onChange={setTab} />
      </View>
      {waiting > 0 && conn === "online" && (
        <View style={[styles.waiting, { backgroundColor: colors.surface }]}>
          <StatusDot state="waiting" size={10} />
          <Text variant="secondary" color="textStrong">{waiting === 1 ? "1 session is waiting for you" : `${waiting} sessions are waiting for you`}</Text>
        </View>
      )}
      {tab === "workspaces" ? (
        <WorkspacesView query={query} />
      ) : data.length === 0 ? (
        <Empty loaded={loaded} syncing={conn === "connecting"} searching={query.length > 0} onNew={() => router.push("/new")} />
      ) : (
        <FlashList
          data={data}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          stickyHeaderIndices={stickyHeaderIndices}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textMuted} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
          renderItem={({ item }) => (item.kind === "header" ? <SectionHeader title={item.title} count={item.count} onPress={item.workspaceId ? () => router.push({ pathname: "/workspace/[id]", params: { id: item.workspaceId! } }) : undefined} /> : <SessionRow agent={item.agent} subtitle={item.workspace} onPress={open} onLongPress={actions.open} />)}
        />
      )}
      <RenameDialog initial={actions.renaming?.title ?? null} onSubmit={actions.submitRename} onClose={actions.closeRename} />
    </View>
  );
}

const SectionHeader = memo(function SectionHeader({ title, count, onPress }: { title: string; count: number; onPress?: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole={onPress ? "button" : "header"} accessibilityLabel={onPress ? `${title}, open workspace` : title} disabled={!onPress} onPress={onPress} style={[styles.sectionHeader, { backgroundColor: colors.background }]}>
      <Text variant="secondary" color="textMuted" style={{ fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</Text>
      <View style={{ flex: 1 }} />
      <Text variant="secondary" color="textSubtle">{count}</Text>
      {onPress && <Icon name="chevron.right" size={11} color="textSubtle" />}
    </Pressable>
  );
});

function Empty({ loaded, syncing, searching, onNew }: { loaded: boolean; syncing: boolean; searching: boolean; onNew: () => void }) {
  if (!loaded && syncing) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator />
        <Text variant="secondary" color="textMuted">Loading sessions…</Text>
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Text variant="title" color="textStrong">{searching ? "No matching sessions" : "No sessions yet"}</Text>
      {!searching && <Button title="Start a session" kind="primary" onPress={onNew} />}
    </View>
  );
}

const styles = StyleSheet.create({
  headerButton: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  waiting: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xs, minHeight: 40 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 68, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl },
});
