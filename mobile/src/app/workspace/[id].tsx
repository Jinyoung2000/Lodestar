import { Redirect, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { Agent, SessionSort } from "@shared/protocol";
import { buildProject, compareAgents, shortPath, topWorkspace, type Location } from "../../logic/workspaces";
import { sortPrefs, store, useAppState, useSessionSort } from "../../state/app";
import { MIN_TOUCH, radius, spacing, useColors } from "../../theme/theme";
import { ConnectionBanner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { ProjectIcon } from "../../ui/ProjectIcon";
import { RenameDialog } from "../../ui/RenameDialog";
import { Segmented } from "../../ui/Segmented";
import { SessionRow } from "../../ui/SessionRow";
import { Text } from "../../ui/Text";
import { confirmRemove } from "../../ui/WorkspacesView";
import { useSessionActions } from "../../ui/sessionActions";

export default function WorkspaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const workspaces = useAppState((s) => s.workspaces);
  const agents = useAppState((s) => s.agents);
  const git = useAppState((s) => s.git);
  const conn = useAppState((s) => s.conn);
  const hostName = useAppState((s) => s.hostName);
  const loaded = useAppState((s) => s.loaded);
  const actions = useSessionActions();
  const [refreshing, setRefreshing] = useState(false);
  const top = useMemo(() => topWorkspace(workspaces, id), [workspaces, id]);
  const sessionSort = useSessionSort(top?.id ?? id);
  const project = useMemo(() => (top ? buildProject(top, workspaces, agents, sessionSort) : null), [top, workspaces, agents, sessionSort]);
  const info = top ? git[top.id] : undefined;

  useEffect(() => {
    if (top && conn === "online") void store.refreshGit([top.id]);
  }, [top?.id, conn]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await store.sync().catch(() => {});
    if (top) await store.refreshGit([top.id]);
    setRefreshing(false);
  }, [top]);

  const open = useCallback((agentId: string) => router.push({ pathname: "/session/[id]", params: { id: agentId } }), [router]);

  if (!project || !top) {
    return loaded && conn === "online" ? <Redirect href="/" /> : <View style={{ flex: 1 }} />;
  }

  const startHere = (location: Location) => router.push({ pathname: "/new", params: { workspace: top.id, ...(location.kind === "worktree" ? { location: location.workspace.id } : {}) } });
  const compare = compareAgents(sessionSort);
  const everyoneDone = [project.main, ...project.worktrees].flatMap((l) => l.done.map((agent) => ({ agent, label: l.kind === "main" ? "Main folder" : l.label }))).sort((a, b) => compare(a.agent, b.agent));
  const notGit = info !== undefined && info.repoRoot === null;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: top.name }} />
      <ConnectionBanner status={conn} hostName={hostName} />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textMuted} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
      >
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.cardHead}>
            <ProjectIcon name={top.name} size={44} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="title" color="textStrong" numberOfLines={1}>{top.name}</Text>
              <Text variant="secondary" color="textMuted" numberOfLines={2} selectable>{shortPath(top.dir)}</Text>
            </View>
          </View>
          <View style={styles.facts}>
            <Icon name="arrow.triangle.branch" size={14} color="textSubtle" />
            <Text variant="secondary" color="textMuted" style={{ flex: 1 }} numberOfLines={1}>
              {info === undefined ? "Reading git…" : info.repoRoot === null ? "Not a git repository" : `${info.current ?? "detached HEAD"}${info.uncommitted > 0 ? ` · ${info.uncommitted} uncommitted change${info.uncommitted === 1 ? "" : "s"}` : " · clean"}`}
            </Text>
          </View>
        </View>

        <View style={styles.buttons}>
          <Button title="New session" kind="primary" onPress={() => router.push({ pathname: "/new", params: { workspace: top.id } })} flex />
          <Button title="New worktree" onPress={() => router.push({ pathname: "/new", params: { workspace: top.id, place: "worktree" } })} disabled={notGit} flex />
        </View>
        {notGit && <Text variant="caption" color="textSubtle" style={styles.note}>A worktree needs a git repository.</Text>}

        <Text variant="caption" color="textSubtle" style={styles.note}>Sort sessions by</Text>
        <Segmented options={SESSION_SORT_OPTIONS} value={sessionSort} onChange={(next) => sortPrefs.setSessionSort(top.id, next)} />

        {[project.main, ...project.worktrees].map((location) => (
          <LocationSection key={location.workspace.id} location={location} branch={location.kind === "main" ? (info?.current ?? null) : null} time={sessionSort} onStart={startHere} onOpen={open} onMore={actions.open} />
        ))}

        {everyoneDone.length > 0 && (
          <View>
            <SectionTitle title="Done" count={everyoneDone.length} />
            {everyoneDone.map(({ agent, label }) => (
              <SessionRow key={agent.id} agent={agent} subtitle={label} time={sessionSort} onPress={open} onLongPress={actions.open} />
            ))}
          </View>
        )}

        <View style={styles.danger}>
          <Button title="Remove from list" kind="plain" onPress={() => confirmRemove(top.id, top.name, () => router.replace("/"))} />
          <Text variant="caption" color="textSubtle" style={{ textAlign: "center" }}>Files on your Mac are not changed. Sessions are hidden and come back if you add the folder again.</Text>
        </View>
      </ScrollView>
      <RenameDialog initial={actions.renaming?.title ?? null} onSubmit={actions.submitRename} onClose={actions.closeRename} />
    </View>
  );
}

const SESSION_SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
];

function SectionTitle({ title, count, plain, children }: { title: string; count?: number; plain?: boolean; children?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.sectionHeader, { backgroundColor: colors.background }]}>
      <Text variant="secondary" color="textMuted" style={plain ? { fontWeight: "600" } : { fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 }} numberOfLines={1}>{title}</Text>
      {count !== undefined && <Text variant="secondary" color="textSubtle">{count}</Text>}
      <View style={{ flex: 1 }} />
      {children}
    </View>
  );
}

function LocationSection({ location, branch, time, onStart, onOpen, onMore }: { location: Location; branch: string | null; time: SessionSort; onStart: (location: Location) => void; onOpen: (id: string) => void; onMore: (agent: Agent) => void }) {
  const worktree = location.kind === "worktree";
  return (
    <View>
      <SectionTitle plain title={worktree ? location.label : branch ? `Main folder · ${branch}` : "Main folder"} count={location.sessions.length}>
        {worktree && <Text variant="caption" color="textSubtle">worktree</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`New session in ${worktree ? location.label : "main folder"}`} hitSlop={8} onPress={() => onStart(location)} style={styles.plus}>
          <Icon name="plus" size={18} color="accentText" weight="semibold" />
        </Pressable>
      </SectionTitle>
      {location.sessions.length === 0 ? (
        <Text variant="secondary" color="textSubtle" style={styles.none}>No sessions here yet</Text>
      ) : (
        location.sessions.map((agent) => <SessionRow key={agent.id} agent={agent} subtitle={worktree ? location.label : "Main folder"} time={time} onPress={onOpen} onLongPress={onMore} />)
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl },
  card: { margin: spacing.lg, padding: spacing.lg, gap: spacing.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  cardHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  facts: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  buttons: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg },
  note: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: MIN_TOUCH, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  plus: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", marginRight: -spacing.sm },
  none: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  danger: { gap: spacing.sm, padding: spacing.lg, marginTop: spacing.xl },
});
