import { FlashList } from "@shopify/flash-list";
import { useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { buildProjects, moveInOrder, orderOf, shortPath, type Project, type ProjectSort } from "../logic/workspaces";
import { sortPrefs, store, useAppState, useSortPrefs } from "../state/app";
import type { GitSummary } from "../state/store";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { ProjectIcon } from "./ProjectIcon";
import { Segmented } from "./Segmented";
import { StatusDot } from "./StatusDot";
import { Text } from "./Text";
import { showActionMenu } from "./actionMenu";

// 워크스페이스 탭: 맥에 등록된 프로젝트 폴더 목록(Paseo 사이드바의 프로젝트 목록에 해당). 한 줄이 프로젝트 하나이고,
// 이름과 경로, 지금 브랜치와 커밋 안 한 변경, worktree 수, 세션 수와 대표 상태 점이 보인다. 누르면 그 프로젝트의 세션과 worktree 를 보는 화면으로 간다.
// 목록 순서는 위쪽 Sort 줄에서 고른다(최근 활동순, 이름순, 직접 정한 순서). 직접 정한 순서에서는 Reorder 로 위아래 단추가 나오고, 길게 눌러도 옮길 수 있다.
export function WorkspacesView({ query }: { query: string }) {
  const router = useRouter();
  const colors = useColors();
  const workspaces = useAppState((s) => s.workspaces);
  const agents = useAppState((s) => s.agents);
  const git = useAppState((s) => s.git);
  const conn = useAppState((s) => s.conn);
  const loaded = useAppState((s) => s.loaded);
  const [refreshing, setRefreshing] = useState(false);
  const prefs = useSortPrefs();
  const [reordering, setReordering] = useState(false);
  const { sort, order } = prefs.projects;
  const projects = useMemo(() => buildProjects(workspaces, agents, query, sort, order), [workspaces, agents, query, sort, order]);
  // 옮기기는 검색으로 걸러지지 않은 전체 목록 기준이다(걸러진 목록에서 한 칸은 전체에서 몇 칸일지 알 수 없다)
  const movable = sort === "manual" && query.trim() === "";
  const move = useCallback(
    (id: string, direction: "up" | "down" | "top" | "bottom") => {
      sortPrefs.setProjectOrder(moveInOrder(orderOf(buildProjects(workspaces, agents, "", "manual", order)), id, direction));
    },
    [workspaces, agents, order],
  );
  const changeSort = useCallback(
    (next: ProjectSort) => {
      // 처음 직접 정한 순서로 바꿀 때는 지금 보이는 순서가 시작점이다
      sortPrefs.setProjectSort(next, orderOf(buildProjects(workspaces, agents, "", sort, order)));
      if (next !== "manual") setReordering(false);
    },
    [workspaces, agents, sort, order],
  );
  const topIds = useMemo(() => workspaces.filter((w) => !w.parentId && !w.feedback).map((w) => w.id).join(","), [workspaces]);

  // 탭을 열 때와 폴더 목록이 바뀔 때 폴더마다 브랜치를 읽는다(폴더당 git 호출 하나)
  useEffect(() => {
    if (conn === "online" && topIds) void store.refreshGit(topIds.split(","));
  }, [conn, topIds]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await store.sync().catch(() => {});
    await store.refreshGit(topIds ? topIds.split(",") : []);
    setRefreshing(false);
  }, [topIds]);

  const open = useCallback((id: string) => router.push({ pathname: "/workspace/[id]", params: { id } }), [router]);
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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textMuted} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
      extraData={reordering && movable}
      ListHeaderComponent={
        <View>
          <SortBar sort={sort} onChange={changeSort} reordering={reordering && movable} onToggleReorder={movable ? () => setReordering((on) => !on) : undefined} />
          <AddRow onPress={() => router.push("/add-workspace")} />
        </View>
      }
      ListEmptyComponent={<Empty loaded={loaded} syncing={conn === "connecting"} searching={query.length > 0} onAdd={() => router.push("/add-workspace")} />}
      renderItem={({ item, index }) => (
        <ProjectRow
          project={item}
          git={git[item.workspace.id]}
          onPress={open}
          onLongPress={more}
          reorder={movable ? { active: reordering, first: index === 0, last: index === projects.length - 1, onMove: move } : undefined}
        />
      )}
    />
  );
}

// 목록에서 빼기 확인: 파일은 그대로이고, 세션은 숨겨졌다가 같은 폴더를 다시 더하면 돌아온다.
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

function SortBar({ sort, onChange, reordering, onToggleReorder }: { sort: ProjectSort; onChange: (sort: ProjectSort) => void; reordering: boolean; onToggleReorder?: () => void }) {
  return (
    <View>
      <Text variant="caption" color="textSubtle" style={styles.sortCaption}>
        {sort === "activity" ? "Sort by most recent session" : sort === "name" ? "Sort by name" : "Your own order"}
      </Text>
      <Segmented options={SORT_OPTIONS} value={sort} onChange={onChange} />
      {onToggleReorder && (
        <View style={styles.reorderBar}>
          <Text variant="caption" color="textSubtle" style={{ flex: 1 }}>{reordering ? "Use the arrows to move a project." : "Long-press a project to move it."}</Text>
          <Button title={reordering ? "Done" : "Reorder"} kind={reordering ? "primary" : "plain"} onPress={onToggleReorder} />
        </View>
      )}
    </View>
  );
}

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

const ProjectRow = memo(function ProjectRow({ project, git, onPress, onLongPress, reorder }: { project: Project; git: GitSummary | undefined; onPress: (id: string) => void; onLongPress: (project: Project) => void; reorder?: Reorder }) {
  const colors = useColors();
  const { workspace } = project;
  const gitLine = git === undefined ? null : git.repoRoot === null ? "Not a git repository" : `${git.current ?? "detached"}${git.uncommitted > 0 ? ` · ${git.uncommitted} uncommitted` : ""}`;
  const parts = [gitLine, project.worktrees.length ? `${project.worktrees.length} worktree${project.worktrees.length === 1 ? "" : "s"}` : null].filter((part): part is string => part !== null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${workspace.name}, ${project.active} sessions`}
      accessibilityActions={reorder ? MOVE_ACTIONS.filter((action) => (action.name === "moveUp" ? !reorder.first : !reorder.last)) : undefined}
      onAccessibilityAction={(event) => reorder?.onMove(workspace.id, event.nativeEvent.actionName === "moveUp" ? "up" : "down")}
      onPress={() => onPress(workspace.id)}
      onLongPress={() => onLongPress(project)}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : "transparent", borderBottomColor: colors.separator }]}
    >
      <ProjectIcon name={workspace.name} />
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

function Empty({ loaded, syncing, searching, onAdd }: { loaded: boolean; syncing: boolean; searching: boolean; onAdd: () => void }) {
  if (!loaded && syncing) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator />
        <Text variant="secondary" color="textMuted">Loading workspaces…</Text>
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Text variant="title" color="textStrong">{searching ? "No matching workspaces" : "No workspaces yet"}</Text>
      {!searching && <Text variant="secondary" color="textMuted" style={{ textAlign: "center" }}>A workspace is a project folder on your Mac. Add one to start sessions in it.</Text>}
      {!searching && <Button title="Add workspace" kind="primary" onPress={onAdd} />}
    </View>
  );
}

const styles = StyleSheet.create({
  add: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 64, marginHorizontal: spacing.lg, marginTop: spacing.sm, marginBottom: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 76, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  trail: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: MIN_TOUCH },
  sortCaption: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  reorderBar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  moveButton: { width: MIN_TOUCH, height: MIN_TOUCH - 4, alignItems: "center", justifyContent: "center", borderRadius: radius.md, marginLeft: spacing.xs },
  empty: { alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl, paddingTop: 80 },
});
