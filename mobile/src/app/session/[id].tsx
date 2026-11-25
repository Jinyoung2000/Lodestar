import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useNavigation, useRouter, type NativeStackNavigationProp } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { ActivityIndicator, BackHandler, Keyboard, Platform, Pressable, useWindowDimensions, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileFileRef } from "@shared/mobile";
import type { ImageRef } from "@shared/protocol";
import { stateOf, workspaceName } from "../../logic/agents";
import { buildRows, stabilizeRows, type Row } from "../../logic/timeline";
import { readQuestions } from "../../logic/questions";
import { requestDraft, sessionViewState } from "../../state/sessionView";
import { releasePreview, useExpandedPreview } from "../../state/expandedPreview";
import { store, useAppState } from "../../state/app";
import { closePane, commitPanes, isDrawerOpen, setDrawerOpen } from "../../state/split";
import { sessionPreviews, type Preview } from "../../logic/previews";
import { PreviewGallery, PreviewModal, usePreview } from "../../ui/Preview";
import { CreatePreview } from "../../ui/CreatePreview";
import { Button } from "../../ui/Button";
import { createFrameMeter } from "../../state/frames";
import { radius, spacing, useColors } from "../../theme/theme";
import { ProviderLabel, sessionIdentity, useProviderName } from "../../ui/ProviderMark";
import { ConnectionTitle } from "../../ui/ConnectionTitle";
import { Composer } from "../../ui/Composer";
import { useFoldLayout } from "../../ui/FoldLayout";
import { Icon } from "../../ui/Icon";
import { RenameDialog } from "../../ui/RenameDialog";
import { KeyboardSpacer, useKeyboardTop } from "../../ui/KeyboardSpacer";
import { ModelPicker, useModelPicker } from "../../ui/ModelPicker";
import { Text } from "../../ui/Text";
import { ChatRow, rowType } from "../../ui/chat/ChatRow";
import { ApprovalCard, QuestionCard, PlanCard, type Actions } from "../../ui/chat/Cards";
import { useSessionActions } from "../../ui/sessionActions";
import { armSplitDrag, endSplitPress } from "../../ui/SplitDrag";
import { SplitPanes } from "../../ui/SplitPanes";

const NEAR_BOTTOM = 120;
const PAST_THE_END = 1_000_000;
type SessionParams = { id: string; draft?: string; focusQuestion?: string; gallery?: string; viewer?: string };

type PaneUi = { galleryOpen: boolean; viewerOpen: boolean; setGallery: (open: boolean) => void; setViewer: (open: boolean) => void };
type PaneRole = { active: boolean; first: boolean; onClose: () => void };
type SessionViewProps = { id: string; draft?: string; focusQuestion: boolean; ui: PaneUi; pane?: PaneRole };

export default function Session() {
  const params = useLocalSearchParams<SessionParams>();
  const mate = useAppState((s) => s.agents.find((a) => a.id === params.id)?.assistant === true);
  const { panes } = useFoldLayout();
  if (mate) return <Redirect href="/mate" />;
  if (panes.length > 1) return <SplitSessions panes={panes} params={params} />;
  return <RoutedSession key={params.id} params={params} />;
}

function RoutedSession({ params }: { params: SessionParams }) {
  const navigation = useNavigation<NativeStackNavigationProp<{ "session/[id]": SessionParams }, "session/[id]">>();
  const ui = useMemo<PaneUi>(() => ({
    galleryOpen: params.gallery === "1",
    viewerOpen: params.viewer === "1",
    setGallery: (open) => navigation.setParams({ gallery: open ? "1" : undefined }),
    setViewer: (open) => navigation.setParams({ viewer: open ? "1" : undefined }),
  }), [navigation, params.gallery, params.viewer]);
  return <SessionView id={params.id} draft={params.draft} focusQuestion={params.focusQuestion === "1"} ui={ui} />;
}

function SplitSessions({ panes, params }: { panes: readonly string[]; params: SessionParams }) {
  const router = useRouter();
  const activeId = params.id;
  const focus = useCallback((paneId: string) => {
    commitPanes(panes, paneId);
    router.setParams({ id: paneId, focusQuestion: undefined, gallery: undefined, viewer: undefined });
  }, [panes, router]);
  const close = (paneId: string) => {
    const next = closePane(panes, paneId, activeId);
    if (!next.active) {
      router.dismissTo("/");
      return;
    }
    commitPanes(next.panes, next.active);
    router.setParams({ id: next.active, focusQuestion: undefined });
  };
  return <SplitPanes panes={panes} activeId={activeId} onFocus={focus} renderPane={(paneId, index) => (
    <PaneSession id={paneId} draft={paneId === activeId ? params.draft : undefined} focusQuestion={paneId === activeId && params.focusQuestion === "1"}
      pane={{ active: paneId === activeId, first: index === 0, onClose: () => close(paneId) }} />
  )} />;
}

function PaneSession({ id, draft, focusQuestion, pane }: { id: string; draft?: string; focusQuestion: boolean; pane: PaneRole }) {
  const [galleryOpen, setGallery] = useState(false);
  const [viewerOpen, setViewer] = useState(false);
  const ui = useMemo<PaneUi>(() => ({ galleryOpen, viewerOpen, setGallery, setViewer }), [galleryOpen, viewerOpen]);
  return <SessionView id={id} draft={draft} focusQuestion={focusQuestion} ui={ui} pane={pane} />;
}

function SessionView({ id, draft, focusQuestion, ui, pane }: SessionViewProps) {
  const { galleryOpen, viewerOpen, setGallery, setViewer } = ui;
  const router = useRouter();
  const { expanded, paneWidth, connectionInRail, railCollapsed, waiting } = useFoldLayout();
  const ownsScreen = !pane || pane.active;
  const colors = useColors();
  const agent = useAppState((s) => s.agents.find((a) => a.id === id));
  const conn = useAppState((s) => s.conn);
  const model = useModelPicker(agent);
  const { open: modelOpen, close: closeModel } = model;
  const workspaces = useAppState((s) => s.workspaces);
  const timeline = useAppState((s) => s.timelines[id]);
  const listRef = useRef<FlashListRef<Row>>(null);
  const scrollOffset = useRef(0);
  const listHeight = useRef<number | null>(null);
  const contentHeight = useRef(0);
  const previousRows = useRef<Row[]>([]);
  const meter = useRef(createFrameMeter("scroll-js-frame")).current;
  const sessionActions = useSessionActions();

  useEffect(() => {
    void store.openSession(id);
    return () => store.closeSession(id);
  }, [id]);
  useEffect(() => () => meter.stop(), [meter]);

  const [memory] = useState(() => sessionViewState(id));
  const hasNews = !!agent && (!!agent.unread || agent.status === "running" || agent.status === "waiting");
  const restoreAnchor = useRef(hasNews || focusQuestion ? null : memory.anchor);
  const followEnd = useRef(restoreAnchor.current === null);
  const [atBottom, setAtBottom] = useState(followEnd.current);
  const atBottomRef = useRef(followEnd.current);
  const showGallery = useCallback(() => {
    Keyboard.dismiss();
    setGallery(true);
  }, [setGallery]);
  const closeGallery = useCallback(() => setGallery(false), [setGallery]);
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const chatPadding = (paneWidth || windowWidth) < 360 ? spacing.lg : spacing.xl;
  const keyboardTop = useKeyboardTop();
  const insets = useSafeAreaInsets();
  const availableHeight = (keyboardTop ?? windowHeight) - insets.top;
  const compactDock = availableHeight < 480;
  const shortDock = availableHeight < 320;
  const [chatHeight, setChatHeight] = useState(windowHeight);
  const [creatingPreview, setCreatingPreview] = useState(false);
  const createPreview = conn === "online" ? () => { Keyboard.dismiss(); setCreatingPreview(true); } : undefined;
  const items = timeline?.items;
  const files = useMemo(() => sessionPreviews(items ?? []), [items]);
  const preview = usePreview(id, files);
  const { open, close } = preview;
  const previewOpen = viewerOpen && !!preview.selected;
  const fullPreview = useExpandedPreview() === id;
  const openPreview = useCallback((file: Preview) => {
    setViewer(true);
    void open(file);
  }, [open, setViewer]);
  const closePreview = useCallback(() => {
    setViewer(false);
    close();
  }, [close, setViewer]);
  useFocusEffect(useCallback(() => {
    if (!ownsScreen) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isDrawerOpen()) {
        setDrawerOpen(false);
        return true;
      }
      if (modelOpen) {
        closeModel();
        return true;
      }
      if (previewOpen) {
        if (fullPreview && expanded) releasePreview(id);
        else closePreview();
        return true;
      }
      if (galleryOpen) {
        closeGallery();
        return true;
      }
      if (!expanded) return false;
      BackHandler.exitApp();
      return true;
    });
    return () => back.remove();
  }, [closeGallery, closeModel, closePreview, expanded, fullPreview, galleryOpen, id, modelOpen, ownsScreen, previewOpen]));
  const listGeneration = useRef(0);
  const rows = useMemo(() => {
    const previous = previousRows.current;
    const next = stabilizeRows(previous, buildRows(items ?? []));
    const previousKeys = new Set(previous.map((row) => row.key));
    if (previous.length > 0 && !next.some((row) => previousKeys.has(row.key))) {
      listGeneration.current += 1;
      scrollOffset.current = 0;
      contentHeight.current = 0;
      restoreAnchor.current = null;
      followEnd.current = true;
      atBottomRef.current = true;
      memory.anchor = null;
    }
    previousRows.current = next;
    return next;
  }, [items, memory]);

  const pending = rows.findLast((row) => row.type === "question" || row.type === "approval" || row.type === "plan");
  const messages = useMemo(() => pending ? rows.filter(r => r.type !== "question" && r.type !== "approval" && r.type !== "plan") : rows, [rows, pending]);

  const restoreKey = restoreAnchor.current?.key;
  const restoreIndex = restoreKey === undefined ? -1 : messages.findIndex((row) => row.key === restoreKey);

  const actions = useMemo<Actions>(
    () => ({
      allow: (itemId) => store.respondPermission(id, itemId, "allow"),
      deny: (itemId) => store.respondPermission(id, itemId, "deny"),
      answer: (itemId, answers) => store.answerQuestion(id, itemId, answers),
      plan: (itemId, decision) => store.respondPlan(id, itemId, decision),
    }),
    [id],
  );

  const notePosition = useCallback(() => {
    const viewport = listHeight.current;
    if (viewport === null || restoreAnchor.current) return;
    const end = Math.max(0, contentHeight.current - viewport);
    const offset = Math.min(scrollOffset.current, end);
    const near = end - offset < NEAR_BOTTOM;
    const list = listRef.current;
    const index = near || !list ? -1 : list.getFirstVisibleIndex();
    const row = index >= 0 ? list?.props.data?.[index] : undefined;
    const top = index >= 0 ? list?.getLayout(index)?.y : undefined;
    if (near) memory.anchor = null;
    else if (row && list && top !== undefined) memory.anchor = { key: row.key, offset: offset - list.getFirstItemOffset() - top };
    if (near !== atBottomRef.current) {
      atBottomRef.current = near;
      setAtBottom(near);
    }
  }, [memory]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffset.current = e.nativeEvent.contentOffset.y;
    notePosition();
  }, [notePosition]);

  const toEnd = useCallback((animated = true) => {
    restoreAnchor.current = null;
    return listRef.current?.scrollToEnd({ animated });
  }, []);
  const keepBottomEdge = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const previous = listHeight.current;
    const next = nativeEvent.layout.height;
    listHeight.current = next;
    if (previous === null || previous === next) return;
    const content = contentHeight.current;
    const pinnedToEnd = content - (scrollOffset.current + previous) < NEAR_BOTTOM;
    const offset = Math.max(0, pinnedToEnd ? content - next : scrollOffset.current + previous - next);
    scrollOffset.current = offset;
    void listRef.current?.scrollToOffset({ offset, animated: false });
  }, []);

  const dockShare = pending?.type === "question" && readQuestions(pending.item.input).some((q) => q.options.some((o) => o.preview)) ? 0.7 : 0.5;
  const normalDockLimit = keyboardTop === undefined ? Math.min(availableHeight * dockShare, chatHeight - 40) : chatHeight - 40;
  const dockLimit = shortDock ? chatHeight : Math.max(120, normalDockLimit);
  const dock = pending ? { draft: requestDraft(memory, pending.item.id), limit: dockLimit, compact: compactDock, short: shortDock, offline: conn !== "online", focusOnOpen: focusQuestion && !galleryOpen && !previewOpen, onOpen: () => { if (focusQuestion || restoreAnchor.current === null) toEnd(false); } } : null;

  const send = useCallback(
    async (text: string, images: ImageRef[], steer: boolean, files: MobileFileRef[]) => {
      followEnd.current = true;
      atBottomRef.current = true;
      setAtBottom(true);
      setTimeout(() => toEnd(true), 60);
      await store.send(id, text, { steer, images, files });
    },
    [id, toEnd],
  );

  const running = agent?.status === "running";
  const lastMessage = messages.at(-1);
  const showWorking = running && !pending && !(lastMessage?.type === "steps" && lastMessage.running) && !(lastMessage?.type === "assistant" && lastMessage.item.streaming);
  const hasTimeline = !!timeline && (timeline.synced || timeline.cached || timeline.items.length > 0);
  const timelineError = !hasTimeline && conn === "online" ? timeline?.error : undefined;
  const reloadMessages = timelineError ? () => void store.syncTimeline(id) : undefined;
  const title = agent?.title ?? "Session";
  const state = agent ? stateOf(agent) : "idle";
  const providerName = useProviderName(agent?.providerId);
  const workspace = agent ? workspaceName(agent, workspaces) : "";
  const hideChatToolbar = !!pending && availableHeight < 200 && !galleryOpen;
  const showSessions = !!pane?.first && railCollapsed;

  return (
    <View style={{ flex: 1 }}>
      {ownsScreen && <Stack.Screen options={{ headerShown: false, gestureEnabled: !galleryOpen && !previewOpen && !modelOpen }} />}
      <View style={{ flex: 1, paddingRight: expanded && !pane ? insets.right : 0, paddingBottom: expanded && keyboardTop === undefined ? insets.bottom : 0 }} pointerEvents={previewOpen || modelOpen ? "none" : "auto"} accessibilityElementsHidden={previewOpen || modelOpen} importantForAccessibility={previewOpen || modelOpen ? "no-hide-descendants" : "auto"}>
      <View style={{ backgroundColor: colors.background, paddingTop: insets.top, paddingLeft: expanded ? 0 : insets.left, paddingRight: expanded ? 0 : insets.right }}>
        <View>
          {!hideChatToolbar && <View style={[styles.bar, expanded && !showSessions && styles.expandedBar]} pointerEvents={galleryOpen ? "none" : "auto"} accessibilityElementsHidden={galleryOpen} importantForAccessibility={galleryOpen ? "no-hide-descendants" : "auto"}>
            {pane?.active && <View pointerEvents="none" style={[styles.activeLine, { backgroundColor: colors.accentText }]} />}
            {!expanded && <ToolbarButton icon="chevron.left" label="Back" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} />}
            {showSessions && <ToolbarButton icon="line.3.horizontal" label={waiting ? `Sessions, ${waiting} ${waiting === 1 ? "needs" : "need"} your reply` : "Sessions"} badge={waiting || undefined} onPress={() => { Keyboard.dismiss(); setDrawerOpen(true); }} />}
            <Pressable accessible={false} style={styles.title} disabled={!pane} onLongPress={() => armSplitDrag({ agentId: id, title })} onPressOut={endSplitPress}>
              <ConnectionTitle title={title} subtitle={workspace} hidden={connectionInRail || galleryOpen || previewOpen || modelOpen} style={styles.fill}
                detail={agent ? <ProviderLabel harness={agent.harness ?? (agent.providerId ? "claude" : undefined)} providerId={agent.providerId} workspaceId={agent.workspaceId} parts={[workspace]} state={state} maxFontSizeMultiplier={1.2} /> : undefined}>
                <View accessible accessibilityRole="header" accessibilityLabel={agent ? `${title}, ${sessionIdentity(agent.harness, state, providerName)}` : title} style={styles.titleLine}>
                  <Text style={styles.titleText} color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.2}>{title}</Text>
                </View>
              </ConnectionTitle>
            </Pressable>
            {files.length > 0 && <ToolbarButton icon="photo.on.rectangle" count={files.length} label={`Open previews, ${files.length} ${files.length === 1 ? "preview" : "previews"}`} onPress={showGallery} />}
            {(agent || createPreview || reloadMessages) && <ToolbarButton icon="ellipsis" label="Session actions" onPress={() => sessionActions.open(agent, { closeConversation: expanded && !pane ? () => router.dismissTo("/") : undefined, createPreview, reloadMessages })} />}
            {pane && <ToolbarButton icon="xmark" label="Close conversation" onPress={pane.onClose} />}
          </View>}
          {galleryOpen && <View style={[styles.bar, StyleSheet.absoluteFill, { backgroundColor: colors.background }]} onAccessibilityEscape={closeGallery}>
            <ToolbarButton icon="chevron.left" label="Close previews" onPress={closeGallery} />
            <ConnectionTitle title="Previews" hidden={connectionInRail || previewOpen || modelOpen} style={styles.title}>
              <View style={styles.galleryTitle} accessible accessibilityRole="header" accessibilityLabel={`Previews, ${files.length}`}>
                <Text variant="title" color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.shrink}>Previews</Text>
                <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.count}>{files.length}</Text>
              </View>
            </ConnectionTitle>
            <ToolbarButton icon="plus" label="New preview" onPress={createPreview} />
          </View>}
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <View onLayout={({ nativeEvent }) => setChatHeight(nativeEvent.layout.height)} style={[{ flex: 1 }, paneWidth > 752 && styles.readingWidth]} pointerEvents={galleryOpen ? "none" : "auto"} importantForAccessibility={galleryOpen ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={galleryOpen}>
          {!hasTimeline ? (
            <View style={[styles.opening, { paddingHorizontal: chatPadding }]}>
              {conn === "online" && !timelineError && <ActivityIndicator size="small" color={colors.textMuted} />}
              {conn === "online" && <Text variant="secondary" color="textMuted" accessibilityLiveRegion="polite" style={styles.openingText}>
                {timelineError ?? "Opening session…"}
              </Text>}
            </View>
          ) : (
            <View style={{ flex: 1 }} onLayout={keepBottomEdge}>
              <FlashList
                key={listGeneration.current}
                ref={listRef}
                data={messages}
                keyExtractor={(row) => row.key}
                getItemType={rowType}
                renderItem={({ item }) => <ChatRow agentId={id} row={item} showGallery={showGallery} openPreview={openPreview} />}
                ItemSeparatorComponent={Gap}
                contentContainerStyle={{ paddingHorizontal: chatPadding, paddingTop: spacing.sm, paddingBottom: spacing.xs }}
                onContentSizeChange={(_, height) => {
                  contentHeight.current = height;
                  const viewport = listHeight.current;
                  if (followEnd.current && viewport !== null) {
                    scrollOffset.current = Math.max(0, height - viewport);
                    void listRef.current?.scrollToOffset({ offset: scrollOffset.current, animated: false });
                  }
                  notePosition();
                }}
                maintainVisibleContentPosition={{ startRenderingFromBottom: true, disabled: atBottom }}
                drawDistance={windowHeight}
                initialScrollIndex={restoreIndex >= 0 ? restoreIndex : undefined}
                initialScrollIndexParams={restoreIndex >= 0 ? { viewOffset: restoreAnchor.current?.offset } : Platform.OS === "android" ? { viewOffset: PAST_THE_END } : undefined}
                onLoad={() => {
                  if (restoreIndex >= 0) {
                    void listRef.current?.scrollToIndex({ index: restoreIndex, viewOffset: restoreAnchor.current?.offset, animated: false });
                    return;
                  }
                  restoreAnchor.current = null;
                  followEnd.current = true;
                  toEnd(false);
                }}
                onStartReached={() => void store.loadOlder(id)}
                onStartReachedThreshold={0.5}
                onScroll={onScroll}
                onScrollBeginDrag={() => {
                  restoreAnchor.current = null;
                  followEnd.current = false;
                  meter.start();
                }}
                onMomentumScrollEnd={() => {
                  followEnd.current = atBottomRef.current;
                  meter.stop();
                }}
                onScrollEndDrag={() => {
                  followEnd.current = atBottomRef.current;
                  setTimeout(meter.stop, 500);
                }}
                scrollEventThrottle={16}
                keyboardDismissMode="interactive"
                keyboardShouldPersistTaps="handled"
                ListHeaderComponent={timeline?.hasMore ? <View style={styles.olderSlot}>{timeline.loadingOlder && <ActivityIndicator />}</View> : rows.length === 0 ? <Text color="textMuted" style={{ textAlign: "center" }}>No messages yet.</Text> : null}
                ListFooterComponent={<View style={styles.workingSlot}>{showWorking && <Working />}</View>}
              />
              {!atBottom && (
                <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={() => toEnd(true)} style={[styles.latestTarget, { right: chatPadding - 6 }]}>
                  {({ pressed }) => <View style={[styles.latest, { backgroundColor: pressed ? colors.pressed : colors.overlay, borderColor: colors.border }]}>
                    <Icon name="arrow.down" size={18} color="textStrong" weight="semibold" />
                  </View>}
                </Pressable>
              )}
            </View>
          )}
          {dock && pending?.type === "question" && <QuestionCard key={pending.key} item={pending.item} actions={actions} openPreview={openPreview} {...dock} />}
          {dock && pending?.type === "approval" && <ApprovalCard key={pending.key} item={pending.item} tool={pending.tool} reviewOnDesktop={pending.reviewOnDesktop} actions={actions} {...dock} />}
          {dock && pending?.type === "plan" && <PlanCard key={pending.key} item={pending.item} actions={actions} {...dock} />}
          <View style={pending ? { display: "none" } : undefined}>
          <Composer
            agent={agent}
            initialText={draft}
            draftKey={id}
            disabled={conn !== "online" || !agent || !!pending || galleryOpen || previewOpen || modelOpen}
            modelControl={agent ? { harness: model.selection.harness, providerId: model.selection.providerId, name: model.name, effort: model.effort, onPress: model.show } : undefined}
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
        {galleryOpen && <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} onAccessibilityEscape={closeGallery}>
          <PreviewGallery agentId={id} files={files} open={openPreview}
            footer={timeline?.hasMore ? <Button title="Load earlier messages" kind="plain" busy={timeline.loadingOlder} disabled={conn !== "online"} onPress={() => void store.loadOlder(id)} /> : undefined}
          />
        </View>}
      </View>
      {creatingPreview && <CreatePreview close={() => setCreatingPreview(false)} send={async (prompt) => { await store.send(id, prompt, { steer: false, images: [] }); closeGallery(); }} />}
      {!expanded && <KeyboardSpacer />}
      </View>
      {previewOpen && <PreviewModal {...preview} close={closePreview} />}
      {modelOpen && agent && <ModelPicker
        agentId={id}
        selection={model.selection}
        close={model.close}
        keyboardInset={expanded || keyboardTop === undefined ? 0 : Math.max(0, windowHeight - keyboardTop)}
        apply={(selection) => store.setModel(id, selection)}
      />}
      <RenameDialog initial={sessionActions.renaming?.title ?? null} onSubmit={sessionActions.submitRename} onClose={sessionActions.closeRename} />
    </View>
  );
}

function ToolbarButton({ icon, label, count, badge, onPress }: { icon: ComponentProps<typeof Icon>["name"]; label: string; count?: number; badge?: number; onPress?: () => void }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !onPress }} disabled={!onPress} onPress={onPress}
    style={({ pressed }) => [styles.headerButton, count !== undefined && styles.countButton, pressed && { backgroundColor: colors.pressed }]}>
    <Icon name={icon} size={20} color={onPress ? "textStrong" : "textSubtle"} />
    {count !== undefined && <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.count}>{count}</Text>}
    {badge !== undefined && <View style={[styles.badge, { backgroundColor: colors.warning }]}>
      <Text variant="caption" color="background" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.badgeText}>{badge}</Text>
    </View>}
  </Pressable>;
}

const Gap = ({ leadingItem, trailingItem }: { leadingItem?: Row; trailingItem?: Row }) =>
  <View style={{ height: trailingItem?.type === "steps" && leadingItem?.type === "assistant" ? 0 : spacing.sm }} />;

function Working() {
  const colors = useColors();
  return (
    <View style={styles.working}>
      <ActivityIndicator size="small" color={colors.running} />
      <Text variant="secondary" color="textMuted">Working…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headerButton: { width: 48, height: 48, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  countButton: { width: "auto", minWidth: 48, flexDirection: "row", gap: spacing.xs, paddingHorizontal: spacing.sm },
  bar: { minHeight: 48, paddingHorizontal: spacing.xs, flexDirection: "row", gap: spacing.xs, alignItems: "center" },
  expandedBar: { paddingLeft: spacing.lg },
  galleryTitle: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  shrink: { flexShrink: 1 },
  count: { fontVariant: ["tabular-nums"] },
  title: { flex: 1, minWidth: 0 },
  fill: { flex: 1 },
  activeLine: { position: "absolute", top: 0, left: 0, right: 0, height: 2 },
  badge: { position: "absolute", top: 5, right: 1, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 12, lineHeight: 18, fontWeight: "600", fontVariant: ["tabular-nums"] },
  titleText: { flexShrink: 1, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  titleLine: { flexDirection: "row", alignItems: "center", marginBottom: 1 },
  opening: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingTop: spacing.md },
  openingText: { flex: 1 },
  readingWidth: { width: 720, alignSelf: "center" },
  olderSlot: { height: 36, marginBottom: spacing.md, alignItems: "center", justifyContent: "center" },
  workingSlot: { height: 32 },
  working: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingTop: spacing.md },
  latestTarget: { position: "absolute", bottom: spacing.xs, width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  latest: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
});
