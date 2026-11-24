import { FlashList } from "@shopify/flash-list";
import { useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Keyboard, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { buildProjects, moveInOrder, orderOf, shortPath, type Project, type ProjectSort } from "../logic/workspaces";
import { sortPrefs, store, useAppState, useSortPrefs } from "../state/app";
import type { GitSummary } from "../state/store";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Icon } from "./Icon";
import { ProjectIcon } from "./ProjectIcon";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { SortButton } from "./SortButton";
import { StatusDot } from "./StatusDot";
import { Text } from "./Text";
import { showActionMenu } from "./actionMenu";

export function WorkspacesView({ query, selectedId, onOpen }: { query: string; selectedId?: string; onOpen?: (id: string) => void }) {
  const router = useRouter();
  const colors = useColors();
  const workspaces = useAppState((s) => s.workspaces);
  const agents = useAppState((s) => s.agents);
  const git = useAppState((s) => s.git);
  const conn = useAppState((s) => s.conn);
  const [refreshing, setRefreshing] = useState(false);
  const prefs = useSortPrefs();
  const [reordering, setReordering] = useState(false);
  const { sort, order } = prefs.projects;
  const projects = useMemo(() => buildProjects(workspaces, agents, query, sort, order), [workspaces, agents, query, sort, order]);
  const movable = sort === "manual" && query.trim() === "";
  const move = useCallback(
    (id: string, direction: "up" | "down" | "top" | "bottom") => {
      sortPrefs.setProjectOrder(moveInOrder(orderOf(buildProjects(workspaces, agents, "", "manual", order)), id, direction));
    },
    [workspaces, agents, order],
  );
  const changeSort = useCallback(
    (next: ProjectSort) => {
      sortPrefs.setProjectSort(next, orderOf(buildProjects(workspaces, agents, "", sort, order)));
      if (next !== "manual") setReordering(false);
    },
    [workspaces, agents, sort, order],
  );
  const topIds = useMemo(() => workspaces.filter((w) => !w.parentId && !w.feedback).map((w) => w.id).join(","), [workspaces]);

  useEffect(() => {
    if (conn === "online" && topIds) void store.refreshGit(topIds.split(","));
  }, [conn, topIds]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await store.sync().catch(() => {});
    await store.refreshGit(topIds ? topIds.split(",") : []);
    setRefreshing(false);
  }, [topIds]);

  const open = useCallback((id: string) => {
    if (onOpen) {
      Keyboard.dismiss();
      onOpen(id);
    }
    else router.push({ pathname: "/workspace/[id]", params: { id } });
  }, [onOpen, router]);
  const more = useCallback(
    (project: Project) => {
      const id = project.workspace.id;
      const ids = movable ? orderOf(buildProjects(workspaces, agents, "", "manual", order)) : [];
      const at = ids.indexOf(id);
      showActionMenu(project.workspace.name, [
        { label: "Open", onPress: () => open(id) },
        { label: "New session here", onPress: () => router.push({ pathname: "/new", params: { workspace: id } }) },
        ...(at > 0 ? [{ label: "Move up", onPress: () => move(id, "up") }, { label: "Move to top", onPress: () => move(id, "top") }] : []),
        ...(at >= 0 && at < ids.length - 1 ? [{ label: "Move down", onPress: () => move(id, "down") }, { label: "Move to bottom", onPress: () => move(id, "bottom") }] : []),
        { label: "Remove from list…", onPress: () => confirmRemove(id, project.workspace.name) },
      ]);
    },
    [open, router, movable, workspaces, agents, order, move],
  );

  return (
    <FlashList
      data={projects}
      keyExtractor={(project) => project.workspace.id}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps={onOpen ? "handled" : undefined}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textMuted} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
      extraData={{ selectedId, reordering: reordering && movable }}
      ListHeaderComponent={
        <View style={styles.listActions}>
          <AddRow onPress={() => router.push("/add-workspace")} />
          <SortButton label="Sort workspaces" value={sort} options={SORT_OPTIONS} onChange={changeSort}
            action={movable ? { label: reordering ? "Done reordering" : "Reorder", onPress: () => setReordering((on) => !on) } : undefined} />
        </View>
      }
      ListEmptyComponent={<Empty offline={conn !== "online" && workspaces.length === 0} searching={query.trim().length > 0} />}
      renderItem={({ item, index }) => (
        <ProjectRow
          project={item}
          selected={onOpen ? selectedId === item.workspace.id : undefined}
          git={git[item.workspace.id]}
          onPress={open}
          onLongPress={more}
          reorder={movable ? { active: reordering, first: index === 0, last: index === projects.length - 1, onMove: move } : undefined}
        />
      )}
    />
  );
}

export function confirmRemove(id: string, name: string, then?: () => void) {
  Alert.alert(`Remove “${name}” from the list?`, "Files on your Mac are not changed. Its sessions are hidden and come back if you add the folder again.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Remove",
      style: "destructive",
      onPress: () =>
        void store
          .removeWorkspace(id)
          .then(() => then?.())
          .catch((error: unknown) => Alert.alert("Could not remove the folder", error instanceof Error ? error.message : String(error))),
    },
  ]);
}

const SORT_OPTIONS: { value: ProjectSort; label: string }[] = [
  { value: "activity", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "manual", label: "Manual" },
];

function AddRow({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Add workspace" onPress={onPress} style={({ pressed }) => [styles.add, { borderColor: colors.border, backgroundColor: pressed ? colors.pressed : colors.surface }]}>
      <Icon name="folder.badge.plus" size={20} color="accentText" />
      <View style={{ flex: 1 }}>
        <Text variant="title" color="accentText">Add workspace</Text>
        <Text variant="secondary" color="textMuted">Pick a folder on your Mac</Text>
      </View>
    </Pressable>
  );
}

type Reorder = { active: boolean; first: boolean; last: boolean; onMove: (id: string, direction: "up" | "down") => void };

const ProjectRow = memo(function ProjectRow({ project, selected, git, onPress, onLongPress, reorder }: { project: Project; selected?: boolean; git: GitSummary | undefined; onPress: (id: string) => void; onLongPress: (project: Project) => void; reorder?: Reorder }) {
  const colors = useColors();
  const { workspace } = project;
  const gitLine = git === undefined ? null : git.repoRoot === null ? "Not a git repository" : `${git.current ?? "detached"}${git.uncommitted > 0 ? ` · ${git.uncommitted} uncommitted` : ""}`;
  const parts = [gitLine, project.worktrees.length ? `${project.worktrees.length} worktree${project.worktrees.length === 1 ? "" : "s"}` : null].filter((part): part is string => part !== null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      accessibilityLabel={`${workspace.name}, ${project.active} sessions`}
      accessibilityActions={reorder ? MOVE_ACTIONS.filter((action) => (action.name === "moveUp" ? !reorder.first : !reorder.last)) : undefined}
      onAccessibilityAction={(event) => reorder?.onMove(workspace.id, event.nativeEvent.actionName === "moveUp" ? "up" : "down")}
      onPress={() => onPress(workspace.id)}
      onLongPress={() => onLongPress(project)}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : selected ? colors.selected : "transparent", borderBottomColor: colors.separator }]}
    >
      <WorkspaceIcon workspaceId={workspace.id} size={18} fallback={<ProjectIcon strong={selected} />} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="title" color="textStrong" numberOfLines={1}>{workspace.name}</Text>
        <Text variant="secondary" color="textMuted" numberOfLines={1}>{shortPath(workspace.dir)}</Text>
        {parts.length > 0 && <Text variant="caption" color="textSubtle" numberOfLines={1}>{parts.join(" · ")}</Text>}
      </View>
      {reorder?.active ? (
        <View style={styles.trail}>
          <MoveButton icon="chevron.up" label={`Move ${workspace.name} up`} disabled={reorder.first} onPress={() => reorder.onMove(workspace.id, "up")} />
          <MoveButton icon="chevron.down" label={`Move ${workspace.name} down`} disabled={reorder.last} onPress={() => reorder.onMove(workspace.id, "down")} />
        </View>
      ) : (
        <View style={styles.trail}>
          <StatusDot state={project.state} size={10} />
          <Text variant="secondary" color="textSubtle">{project.active}</Text>
        </View>
      )}
      {!reorder?.active && <Icon name="chevron.right" size={13} color="textSubtle" />}
    </Pressable>
  );
});

const MOVE_ACTIONS = [
  { name: "moveUp", label: "Move up" },
  { name: "moveDown", label: "Move down" },
];

function MoveButton({ icon, label, disabled, onPress }: { icon: "chevron.up" | "chevron.down"; label: string; disabled: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} hitSlop={4} onPress={onPress} style={({ pressed }) => [styles.moveButton, { backgroundColor: pressed ? colors.pressed : colors.overlay, opacity: disabled ? 0.35 : 1 }]}>
      <Icon name={icon} size={16} color="accentText" weight="semibold" />
    </Pressable>
  );
}

function Empty({ offline, searching }: { offline: boolean; searching: boolean }) {
  return (
    <View style={styles.empty}>
      <Text variant="title" color="textStrong">{offline ? "No saved workspaces" : searching ? "No matching workspaces" : "No workspaces yet"}</Text>
      {!offline && !searching && <Text variant="secondary" color="textMuted" style={{ textAlign: "center" }}>A workspace is a project folder on your Mac. Add one to start sessions in it.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  listActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingLeft: spacing.lg, paddingRight: spacing.sm, paddingVertical: spacing.sm },
  add: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 52, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 52, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  trail: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: MIN_TOUCH },
  moveButton: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, marginLeft: spacing.xs },
  empty: { alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl, paddingTop: 80 },
});
