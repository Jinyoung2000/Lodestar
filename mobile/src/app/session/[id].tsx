import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, useWindowDimensions, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { ImageRef } from "@shared/protocol";
import { stateOf, workspaceName } from "../../logic/agents";
import { buildRows, stabilizeRows, type Row } from "../../logic/timeline";
import { requestDraft, sessionViewState, type SessionTab } from "../../state/sessionView";
import { store, useAppState } from "../../state/app";
import { sessionPreviews } from "../../logic/previews";
import { PreviewGallery, PreviewModal, usePreview } from "../../ui/Preview";
import { CreatePreview } from "../../ui/CreatePreview";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { createFrameMeter } from "../../state/frames";
import { spacing, useColors } from "../../theme/theme";
import { ProviderMark, sessionIdentity } from "../../ui/ProviderMark";
import { ConnectionBanner, useReconnect } from "../../ui/Banner";
import { Composer } from "../../ui/Composer";
import { useFoldLayout } from "../../ui/FoldLayout";
import { Icon } from "../../ui/Icon";
import { RenameDialog } from "../../ui/RenameDialog";
import { KeyboardSpacer, useKeyboardTop } from "../../ui/KeyboardSpacer";
import { Text } from "../../ui/Text";
import { ChatRow, rowType } from "../../ui/chat/ChatRow";
import { ApprovalCard, QuestionCard, PlanCard, type Actions } from "../../ui/chat/Cards";
import { useSessionActions } from "../../ui/sessionActions";

const NEAR_BOTTOM = 120;

export default function Session() {
  const params = useLocalSearchParams<{ id: string; draft?: string; focusQuestion?: string }>();
  return <SessionView key={params.id} id={params.id} draft={params.draft} focusQuestion={params.focusQuestion === "1"} />;
}

function SessionView({ id, draft, focusQuestion }: { id: string; draft?: string; focusQuestion: boolean }) {
  const router = useRouter();
  const { expanded, paneWidth, sharedConnectionStrip } = useFoldLayout();
  const colors = useColors();
  const agent = useAppState((s) => s.agents.find((a) => a.id === id));
  const workspaces = useAppState((s) => s.workspaces);
  const timeline = useAppState((s) => s.timelines[id]);
  const conn = useAppState((s) => s.conn);
  const reconnect = useReconnect();
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
  useEffect(() => () => meter.stop(), [meter]);

  const [memory] = useState(() => sessionViewState(id));
  const restoreOffset = useRef(memory.offset);
  const [tab, setLocalTab] = useState<SessionTab>(focusQuestion ? "chat" : memory.tab);
  const setTab = useCallback((next: SessionTab) => {
    memory.tab = next;
    setLocalTab(next);
  }, [memory]);
  const { height: windowHeight } = useWindowDimensions();
  const keyboardTop = useKeyboardTop();
  const insets = useSafeAreaInsets();
  const availableHeight = (keyboardTop ?? windowHeight) - insets.top;
  const compactDock = availableHeight < 480;
  const shortDock = availableHeight < 320;
  const [chatHeight, setChatHeight] = useState(windowHeight);
  const showGallery = useCallback(() => { Keyboard.dismiss(); setTab("previews"); }, [setTab]);
  const [creatingPreview, setCreatingPreview] = useState(false);
  const items = timeline?.items;
  const files = useMemo(() => sessionPreviews(items ?? []), [items]);
  const preview = usePreview(id, files);
  const rows = useMemo(() => {
    const next = stabilizeRows(previousRows.current, buildRows(items ?? []));
    previousRows.current = next;
    return next;
  }, [items]);

  const pending = rows.findLast((row) => row.type === "question" || row.type === "approval" || row.type === "plan");
  const messages = useMemo(() => pending ? rows.filter(r => r.type !== "question" && r.type !== "approval" && r.type !== "plan") : rows, [rows, pending]);

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
    memory.offset = near ? null : contentOffset.y;
    if (near !== atBottomRef.current) {
      atBottomRef.current = near;
      setAtBottom(near);
    }
  }, [memory]);

  const toEnd = useCallback((animated = true) => listRef.current?.scrollToEnd({ animated }), []);

  const normalDockLimit = keyboardTop === undefined ? Math.min(availableHeight * 0.62, chatHeight - 40) : chatHeight - 40;
  const dockLimit = shortDock ? chatHeight : Math.max(120, normalDockLimit);
  const dock = pending ? { draft: requestDraft(memory, pending.item.id), limit: dockLimit, compact: compactDock, short: shortDock, offline: conn !== "online", focusOnOpen: focusQuestion, onOpen: () => { if (focusQuestion || restoreOffset.current === null) toEnd(false); } } : null;

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
  const hasTimeline = !!timeline && (timeline.synced || timeline.cached || timeline.items.length > 0);
  const loading = !hasTimeline && conn === "online" && timeline?.loading === true;
  const tryAgain = () => {
    if (conn === "online") void store.syncTimeline(id);
    else reconnect();
  };
  const state = agent ? stateOf(agent) : "idle";

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, paddingRight: expanded ? insets.right : 0, paddingBottom: expanded && keyboardTop === undefined ? insets.bottom : 0 }} accessibilityElementsHidden={!!preview.selected} importantForAccessibility={preview.selected ? "no-hide-descendants" : "auto"}>
      <SafeAreaView edges={sharedConnectionStrip ? [] : ["top"]} style={{ backgroundColor: colors.background }}>
        {!(tab === "chat" && pending && availableHeight < 200) && <View style={[styles.bar, expanded && { paddingLeft: spacing.lg }]}>
          {!expanded && <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} style={styles.headerButton}>
            <Icon name="chevron.left" size={24} color="textStrong" />
          </Pressable>}
          <View style={styles.title} accessibilityRole="header" accessibilityLabel={agent ? [agent.title, sessionIdentity(agent.harness, state), workspaceName(agent, workspaces)].filter(Boolean).join(", ") : undefined}>
            <View style={styles.titleLine}>
              {agent && <ProviderMark harness={agent.harness} state={state} selected />}
              <Text style={{ flexShrink: 1 }} variant="title" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.3}>{agent?.title ?? "Session"}</Text>
            </View>
            {agent && <View style={styles.titleSub}>
              <Text variant="caption" color="textMuted" numberOfLines={1} style={{ flexShrink: 1 }}>{[state === "waiting" ? "Needs your reply" : state === "running" ? "Working" : state === "error" ? "Stopped with an error" : null, workspaceName(agent, workspaces)].filter(Boolean).join(" · ")}</Text>
            </View>}
          </View>
          {agent && <Pressable accessibilityRole="button" accessibilityLabel="Session actions" onPress={() => sessionActions.open(agent, expanded ? () => router.dismissTo("/") : undefined)} style={styles.headerButton}>
            <Icon name="ellipsis" size={22} color="textStrong" />
          </Pressable>}
        </View>}
      </SafeAreaView>
      {!sharedConnectionStrip && <ConnectionBanner />}
      {!(tab === "chat" && pending && compactDock) && <Segmented paneWidth={paneWidth} options={[{ value: "chat", label: "Conversation" }, { value: "previews", label: "Previews", count: files.length }]} value={tab} onChange={(next) => { Keyboard.dismiss(); setTab(next); }} />}
      <View style={{ flex: 1 }}>
        <View onLayout={({ nativeEvent }) => setChatHeight(nativeEvent.layout.height)} style={[{ flex: 1 }, paneWidth > 752 && styles.readingWidth]} pointerEvents={tab === "chat" ? "auto" : "none"} importantForAccessibility={tab === "chat" ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={tab !== "chat"}>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          ) : !hasTimeline ? (
            <View style={styles.unavailable}>
              <Text variant="title" color="textStrong" style={styles.centeredText}>Can’t load this session</Text>
              <Text variant="secondary" color="textMuted" style={styles.centeredText}>It opens when your Mac is reachable.</Text>
              <Button title="Try again" onPress={tryAgain} />
            </View>
          ) : (
            <View style={{ flex: 1 }}>
              <FlashList
                ref={listRef}
                data={messages}
                keyExtractor={(row) => row.key}
                getItemType={rowType}
                renderItem={({ item }) => <ChatRow agentId={id} row={item} showGallery={showGallery} openPreview={preview.open} />}
                ItemSeparatorComponent={Gap}
                contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.lg }}
                maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.25, startRenderingFromBottom: true, animateAutoScrollToBottom: false }}
                onLoad={() => {
                  const offset = restoreOffset.current;
                  if (offset !== null && !focusQuestion) void listRef.current?.scrollToOffset({ offset, animated: false });
                  else toEnd(false);
                }}
                onStartReached={() => void store.loadOlder(id)}
                onStartReachedThreshold={0.5}
                onScroll={onScroll}
                onScrollBeginDrag={meter.start}
                onMomentumScrollEnd={meter.stop}
                onScrollEndDrag={() => setTimeout(meter.stop, 500)}
                scrollEventThrottle={64}
                keyboardDismissMode="interactive"
                keyboardShouldPersistTaps="handled"
                ListHeaderComponent={timeline?.loadingOlder ? <ActivityIndicator style={{ marginBottom: spacing.md }} /> : rows.length === 0 ? <Text color="textMuted" style={{ textAlign: "center" }}>No messages yet.</Text> : null}
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
          {dock && pending?.type === "question" && <QuestionCard key={pending.key} item={pending.item} actions={actions} {...dock} />}
          {dock && pending?.type === "approval" && <ApprovalCard key={pending.key} item={pending.item} tool={pending.tool} reviewOnDesktop={pending.reviewOnDesktop} actions={actions} {...dock} />}
          {dock && pending?.type === "plan" && <PlanCard key={pending.key} item={pending.item} actions={actions} {...dock} />}
          <View style={pending ? { display: "none" } : undefined}>
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
          </View>
        </View>
        {tab === "previews" && <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
          <PreviewGallery agentId={id} files={files} open={preview.open}
            canCreate={conn === "online"} onCreate={() => setCreatingPreview(true)}
            footer={timeline?.hasMore ? <Button title="Load earlier messages" kind="plain" busy={timeline.loadingOlder} disabled={conn !== "online"} onPress={() => void store.loadOlder(id)} /> : undefined}
          />
        </View>}
      </View>
      {creatingPreview && <CreatePreview close={() => setCreatingPreview(false)} send={async (prompt) => { await store.send(id, prompt, { steer: false, images: [] }); setTab("chat"); }} />}
      {!expanded && <KeyboardSpacer />}
      </View>
      <PreviewModal {...preview} />
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
  headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  bar: { minHeight: 56, paddingHorizontal: spacing.xs, flexDirection: "row", gap: spacing.xs, alignItems: "center" },
  title: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  centeredText: { textAlign: "center" },
  unavailable: { flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.sm, padding: spacing.lg },
  titleSub: { flexDirection: "row", alignItems: "center", gap: 2 },
  readingWidth: { width: 720, alignSelf: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  working: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingTop: spacing.md },
  latest: { position: "absolute", alignSelf: "center", bottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 40, paddingHorizontal: spacing.lg, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
});
