import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { MobileBrowseResult } from "@shared/mobile";
import { store, useAppState } from "../state/app";
import { MIN_TOUCH, radius, spacing, useColors } from "../theme/theme";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { KeyboardSpacer } from "../ui/KeyboardSpacer";
import { Text } from "../ui/Text";

// 워크스페이스 추가: 맥의 홈 폴더 아래를 한 단계씩 둘러보며 폴더를 고르거나, 경로를 직접 적는다(Paseo 의 Add project 의 Browse 와 Search for directory 를 한 화면에 모았다).
// 폰이 볼 수 있는 것은 폴더 이름과 git 여부뿐이다(숨김 폴더, Library 같은 시스템 폴더, 홈 밖은 데몬이 거절한다). 맨 아래 단추는 지금 입력칸에 있는 경로를 추가한다.
export default function AddWorkspace() {
  const router = useRouter();
  const colors = useColors();
  const conn = useAppState((s) => s.conn);
  const [view, setView] = useState<MobileBrowseResult | null>(null);
  const [text, setText] = useState("~");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const go = useCallback(async (path: string) => {
    const mine = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await store.browse(path);
      if (mine !== request.current) return;
      setView(result);
      setText(result.path);
    } catch (e) {
      if (mine === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (conn === "online" && !view) void go("~");
  }, [conn, view, go]);

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const workspace = await store.addWorkspace(text.trim());
      router.replace({ pathname: "/workspace/[id]", params: { id: workspace.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAdding(false);
    }
  };

  const typed = text.trim();
  const edited = view !== null && typed !== view.path;
  const atHome = typed === "~" || typed === "";
  const name = typed.split("/").filter(Boolean).pop() ?? "";
  const added = view !== null && !edited ? view.workspaceId : null;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ headerRight: () => <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8} style={{ minHeight: MIN_TOUCH, justifyContent: "center" }}><Text color="accentText">Cancel</Text></Pressable> }} />
      <View style={styles.pathRow}>
        <TextInput
          accessibilityLabel="Folder path"
          value={text}
          onChangeText={setText}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="go"
          onSubmitEditing={() => void go(typed)}
          placeholder="~/Repos/my-app"
          placeholderTextColor={colors.textSubtle}
          style={[styles.input, { color: colors.textStrong, borderColor: error ? colors.danger : colors.border, backgroundColor: colors.surface }]}
        />
        <Button title="Go" onPress={() => void go(typed)} disabled={conn !== "online" || !typed} style={styles.go} />
      </View>
      {error && <Text variant="secondary" color="danger" style={styles.error}>{error}</Text>}
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.lg }}>
        {conn !== "online" && <Text variant="secondary" color="textMuted" style={styles.error}>Connect to your Mac to browse its folders.</Text>}
        {view && !edited && view.parent !== null && <Row icon="arrow.up" title={`Up to ${view.parent}`} onPress={() => void go(view.parent!)} />}
        {view && !edited && view.entries.map((entry) => (
          <Row key={entry.name} icon={entry.git ? "arrow.triangle.branch" : "folder"} title={entry.name} subtitle={entry.workspaceId ? "Already added" : entry.git ? "Git repository" : undefined} added={entry.workspaceId !== null} onPress={() => void go(`${view.path}/${entry.name}`)} />
        ))}
        {view && !edited && view.entries.length === 0 && <Text variant="secondary" color="textMuted" style={styles.error}>No folders in here.</Text>}
        {view?.truncated && !edited && <Text variant="caption" color="textSubtle" style={styles.error}>Only the first {view.entries.length} folders are shown. Type a path to go further.</Text>}
        {edited && <Text variant="secondary" color="textMuted" style={styles.error}>Press Go to open this path, or Add to add it as it is.</Text>}
        {loading && <ActivityIndicator style={{ marginTop: spacing.lg }} />}
      </ScrollView>
      <View style={[styles.bar, { borderTopColor: colors.separator, backgroundColor: colors.background }]}>
        {view && !edited && (
          <Text variant="caption" color="textSubtle" numberOfLines={2}>{added ? "This folder is already a workspace." : atHome ? "Open a folder to add it as a workspace." : view.git ? "Git repository: new sessions can start in a worktree." : "Not a git repository: worktrees need git, but you can still add it."}</Text>
        )}
        {added ? (
          <Button title={`Open “${name}”`} onPress={() => router.replace({ pathname: "/workspace/[id]", params: { id: added } })} />
        ) : (
          <Button title={atHome ? "Add workspace" : `Add “${name}”`} kind="primary" onPress={() => void add()} busy={adding} disabled={conn !== "online" || atHome || !typed} />
        )}
      </View>
      <KeyboardSpacer />
    </View>
  );
}

function Row({ icon, title, subtitle, added, onPress }: { icon: "arrow.up" | "folder" | "arrow.triangle.branch"; title: string; subtitle?: string; added?: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}${subtitle ? `, ${subtitle}` : ""}`} onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : "transparent", borderBottomColor: colors.separator }]}>
      <Icon name={icon} size={20} color={icon === "arrow.triangle.branch" ? "accentText" : "textMuted"} />
      <View style={{ flex: 1 }}>
        <Text variant="body" color="textStrong" numberOfLines={1}>{title}</Text>
        {subtitle && <Text variant="caption" color={added ? "textSubtle" : "textMuted"} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {added ? <Icon name="checkmark.circle" size={18} color="textSubtle" /> : <Icon name="chevron.right" size={13} color="textSubtle" />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pathRow: { flexDirection: "row", gap: spacing.sm, padding: spacing.lg, paddingBottom: spacing.sm },
  input: { flex: 1, minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, fontSize: 16 },
  go: { minWidth: 64, paddingHorizontal: spacing.md },
  error: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 56, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  bar: { gap: spacing.sm, padding: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
});
