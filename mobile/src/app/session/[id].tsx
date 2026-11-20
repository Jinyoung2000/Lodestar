import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Stack, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { ImageRef } from "@shared/protocol";
import { stateOf, workspaceName } from "../../logic/agents";
import { buildRows, stabilizeRows, type Row } from "../../logic/timeline";
import { store, useAppState } from "../../state/app";
import { createFrameMeter } from "../../state/frames";
import { spacing, useColors } from "../../theme/theme";
import { ConnectionBanner } from "../../ui/Banner";
import { Composer } from "../../ui/Composer";
import { Icon } from "../../ui/Icon";
import { RenameDialog } from "../../ui/RenameDialog";
import { KeyboardSpacer } from "../../ui/KeyboardSpacer";
import { StatusDot } from "../../ui/StatusDot";
import { Text } from "../../ui/Text";
import { ChatRow, rowType } from "../../ui/chat/ChatRow";
import type { Actions } from "../../ui/chat/Cards";
import { useSessionActions } from "../../ui/sessionActions";

// 대화 화면. 캐시된 마지막 메시지가 바로 보이고, 서버의 최신 조각이 오면 맞춰진다. 맨 아래에 붙어 있으면 새 글을 따라가고, 위로 올리면 "Latest" 단추가 나온다.
const NEAR_BOTTOM = 120;

export default function Session() {
  const { id, draft } = useLocalSearchParams<{ id: string; draft?: string }>();
  const colors = useColors();
  const agent = useAppState((s) => s.agents.find((a) => a.id === id));
  const workspaces = useAppState((s) => s.workspaces);
  const timeline = useAppState((s) => s.timelines[id]);
  const conn = useAppState((s) => s.conn);
  const hostName = useAppState((s) => s.hostName);
  const listRef = useRef<FlashListRef<Row>>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const previousRows = useRef<Row[]>([]);
  const meter = useRef(createFrameMeter("scroll-js-frame")).current;
  const sessionActions = useSessionActions();

  useEffect(() => {
    void store.openSession(id);
    return () => store.closeSession(id);
  }, [id]);
  // 스크롤이 끝나기 전에 화면을 떠나면 끝 이벤트가 오지 않는다. 그대로 두면 측정 루프가 매 프레임 계속 돈다.
  useEffect(() => () => meter.stop(), [meter]);

  const items = timeline?.items;
  const rows = useMemo(() => {
    const next = stabilizeRows(previousRows.current, buildRows(items ?? []));
    previousRows.current = next;
    return next;
  }, [items]);

  const actions = useMemo<Actions>(
    () => ({
      allow: (itemId) => store.respondPermission(id, itemId, "allow").then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
      deny: (itemId) => store.respondPermission(id, itemId, "deny"),
      answer: (itemId, answers) => store.answerQuestion(id, itemId, answers),
      plan: (itemId, decision) => store.respondPlan(id, itemId, decision),
    }),
    [id],
  );

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const near = contentSize.height - (contentOffset.y + layoutMeasurement.height) < NEAR_BOTTOM;
    if (near !== atBottomRef.current) {
      atBottomRef.current = near;
      setAtBottom(near);
    }
  }, []);

  const toEnd = useCallback((animated = true) => listRef.current?.scrollToEnd({ animated }), []);

  const send = useCallback(
    async (text: string, images: ImageRef[], steer: boolean) => {
      await store.send(id, text, { steer, images });
      atBottomRef.current = true;
      setAtBottom(true);
      setTimeout(() => toEnd(true), 60);
    },
    [id, toEnd],
  );

  const running = agent?.status === "running";
  const loading = !timeline || (!timeline.synced && timeline.items.length === 0);
  const state = agent ? stateOf(agent) : "idle";

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerRight: () =>
            agent ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Session actions" hitSlop={8} onPress={() => sessionActions.open(agent)} style={styles.headerButton}>
                <Icon name="ellipsis.circle" size={22} color="accentText" />
              </Pressable>
            ) : null,
          headerTitle: () => (
            <View style={styles.title} accessibilityRole="header">
              <Text variant="title" color="textStrong" numberOfLines={1}>{agent?.title ?? "Session"}</Text>
              <View style={styles.titleSub}>
                <StatusDot state={state} size={8} />
                <Text variant="caption" color="textMuted" numberOfLines={1}>{agent ? workspaceName(agent, workspaces) : ""}</Text>
              </View>
            </View>
          ),
        }}
      />
      <ConnectionBanner status={conn} hostName={hostName} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <FlashList
            ref={listRef}
            data={rows}
            keyExtractor={(row) => row.key}
            getItemType={rowType}
            renderItem={({ item }) => <ChatRow row={item} actions={actions} />}
            ItemSeparatorComponent={Gap}
            contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.lg }}
            maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.25, startRenderingFromBottom: true, animateAutoScrollToBottom: false }}
            onLoad={() => setTimeout(() => toEnd(false), 30)}
            onStartReached={() => void store.loadOlder(id)}
            onStartReachedThreshold={0.5}
            onScroll={onScroll}
            onScrollBeginDrag={meter.start}
            onMomentumScrollEnd={meter.stop}
            onScrollEndDrag={() => setTimeout(meter.stop, 500)}
            scrollEventThrottle={64}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={timeline?.hasMore ? <ActivityIndicator style={{ marginBottom: spacing.md }} /> : rows.length === 0 ? <Text color="textMuted" style={{ textAlign: "center" }}>No messages yet.</Text> : null}
            ListFooterComponent={running ? <Working /> : null}
          />
          {!atBottom && (
            <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={() => toEnd(true)} style={[styles.latest, { backgroundColor: colors.overlay, borderColor: colors.border }]}>
              <Icon name="arrow.down" size={16} color="textStrong" weight="semibold" />
              <Text variant="secondary" color="textStrong">Latest</Text>
            </Pressable>
          )}
        </View>
      )}
      <Composer
        agent={agent}
        initialText={draft}
        draftKey={id}
        disabled={conn !== "online"}
        placeholder={conn === "online" ? "Message" : "Offline"}
        onSend={send}
        onStop={() => void store.interrupt(id).catch(() => {})}
        onDequeue={async (queueId) => (await store.dequeue(id, queueId))?.text ?? null}
        onSendQueuedNow={(queueId) => void store.sendQueuedNow(id, queueId).catch(() => {})}
        onCancelSteering={async (steeringId) => {
          const result = await store.cancelSteering(id, steeringId);
          return result && result.cancelled ? (result.text ?? null) : null;
        }}
      />
      <KeyboardSpacer />
      <RenameDialog initial={sessionActions.renaming?.title ?? null} onSubmit={sessionActions.submitRename} onClose={sessionActions.closeRename} />
    </View>
  );
}

const Gap = () => <View style={{ height: spacing.md }} />;

function Working() {
  return (
    <View style={styles.working}>
      <ActivityIndicator size="small" />
      <Text variant="secondary" color="textMuted">Working…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { alignItems: "center", maxWidth: 240 },
  titleSub: { flexDirection: "row", alignItems: "center", gap: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  working: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingTop: spacing.md },
  latest: { position: "absolute", alignSelf: "center", bottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 40, paddingHorizontal: spacing.lg, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
});
