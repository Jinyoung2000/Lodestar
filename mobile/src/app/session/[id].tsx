import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Stack, useFocusEffect, useLocalSearchParams, useNavigation, useRouter, type NativeStackNavigationProp } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { ActivityIndicator, BackHandler, Keyboard, Pressable, useWindowDimensions, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileFileRef } from "@shared/mobile";
import type { ImageRef } from "@shared/protocol";
import { stateOf, workspaceName } from "../../logic/agents";
import { buildRows, stabilizeRows, type Row } from "../../logic/timeline";
import { requestDraft, sessionViewState } from "../../state/sessionView";
import { releasePreview, useExpandedPreview } from "../../state/expandedPreview";
import { store, useAppState } from "../../state/app";
import { sessionPreviews, type Preview } from "../../logic/previews";
import { PreviewGallery, PreviewModal, usePreview } from "../../ui/Preview";
import { CreatePreview } from "../../ui/CreatePreview";
import { Button } from "../../ui/Button";
import { createFrameMeter } from "../../state/frames";
import { radius, spacing, useColors } from "../../theme/theme";
import { ProviderLabel, sessionIdentity } from "../../ui/ProviderMark";
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

const NEAR_BOTTOM = 120;
type SessionParams = { id: string; draft?: string; focusQuestion?: string; gallery?: string; viewer?: string };

export default function Session() {
  const params = useLocalSearchParams<SessionParams>();
  return <SessionView key={params.id} id={params.id} draft={params.draft} focusQuestion={params.focusQuestion === "1"} galleryOpen={params.gallery === "1"} viewerOpen={params.viewer === "1"} />;
}

function SessionView({ id, draft, focusQuestion, galleryOpen, viewerOpen }: { id: string; draft?: string; focusQuestion: boolean; galleryOpen: boolean; viewerOpen: boolean }) {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<{ "session/[id]": SessionParams }, "session/[id]">>();
  const { expanded, paneWidth, connectionInRail } = useFoldLayout();
  const colors = useColors();
  const agent = useAppState((s) => s.agents.find((a) => a.id === id));
  const conn = useAppState((s) => s.conn);
  const model = useModelPicker(agent);
  const { open: modelOpen, close: closeModel } = model;
  const workspaces = useAppState((s) => s.workspaces);
  const timeline = useAppState((s) => s.timelines[id]);
  const listRef = useRef<FlashListRef<Row>>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
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
  const restoreOffset = useRef(hasNews || focusQuestion ? null : memory.offset);
  const followEnd = useRef(restoreOffset.current === null);
  const showGallery = useCallback(() => {
    Keyboard.dismiss();
    navigation.setParams({ gallery: "1" });
  }, [navigation]);
  const closeGallery = useCallback(() => navigation.setParams({ gallery: undefined }), [navigation]);
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
    navigation.setParams({ viewer: "1" });
    void open(file);
  }, [navigation, open]);
  const closePreview = useCallback(() => {
    navigation.setParams({ viewer: undefined });
    close();
  }, [close, navigation]);
  useFocusEffect(useCallback(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
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
  }, [closeGallery, closeModel, closePreview, expanded, fullPreview, galleryOpen, id, modelOpen, previewOpen]));
  const listGeneration = useRef(0);
  const [listReset, setListReset] = useState(0);
  const rows = useMemo(() => {
    const previous = previousRows.current;
    const next = stabilizeRows(previous, buildRows(items ?? []));
    const previousKeys = new Set(previous.map((row) => row.key));
    if (previous.length > 0 && !next.some((row) => previousKeys.has(row.key))) {
      listGeneration.current += 1;
      scrollOffset.current = 0;
      contentHeight.current = 0;
      restoreOffset.current = null;
      followEnd.current = true;
      atBottomRef.current = true;
      memory.offset = null;
    }
    previousRows.current = next;
    return next;
  }, [items, memory]);

  const pending = rows.findLast((row) => row.type === "question" || row.type === "approval" || row.type === "plan");
  const messages = useMemo(() => pending ? rows.filter(r => r.type !== "question" && r.type !== "approval" && r.type !== "plan") : rows, [rows, pending]);

  const actions = useMemo<Actions>(
    () => ({
      allow: (itemId) => store.respondPermission(id, itemId, "allow"),
      deny: (itemId) => store.respondPermission(id, itemId, "deny"),
      answer: (itemId, answers) => store.answerQuestion(id, itemId, answers),
      plan: (itemId, decision) => store.respondPlan(id, itemId, decision),
    }),
    [id],
  );

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollOffset.current = contentOffset.y;
    contentHeight.current = contentSize.height;
    const near = contentSize.height - (contentOffset.y + layoutMeasurement.height) < NEAR_BOTTOM;
    memory.offset = near ? null : contentOffset.y;
    if (near !== atBottomRef.current) {
      atBottomRef.current = near;
      setAtBottom(near);
    }
  }, [memory]);

  const toEnd = useCallback((animated = true) => listRef.current?.scrollToEnd({ animated }), []);
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

  const normalDockLimit = keyboardTop === undefined ? Math.min(availableHeight * 0.5, chatHeight - 40) : chatHeight - 40;
  const dockLimit = shortDock ? chatHeight : Math.max(120, normalDockLimit);
  const dock = pending ? { draft: requestDraft(memory, pending.item.id), limit: dockLimit, compact: compactDock, short: shortDock, offline: conn !== "online", focusOnOpen: focusQuestion && !galleryOpen && !previewOpen, onOpen: () => { if (focusQuestion || restoreOffset.current === null) toEnd(false); } } : null;

  const send = useCallback(
    async (text: string, images: ImageRef[], steer: boolean, files: MobileFileRef[]) => {
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
  const workspace = agent ? workspaceName(agent, workspaces) : "";
  const hideChatToolbar = !!pending && availableHeight < 200 && !galleryOpen;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !galleryOpen && !previewOpen && !modelOpen }} />
      <View style={{ flex: 1, paddingRight: expanded ? insets.right : 0, paddingBottom: expanded && keyboardTop === undefined ? insets.bottom : 0 }} pointerEvents={previewOpen || modelOpen ? "none" : "auto"} accessibilityElementsHidden={previewOpen || modelOpen} importantForAccessibility={previewOpen || modelOpen ? "no-hide-descendants" : "auto"}>
      <SafeAreaView edges={expanded ? ["top"] : ["top", "left", "right"]} style={{ backgroundColor: colors.background }}>
        <View>
          {!hideChatToolbar && <View style={[styles.bar, expanded && styles.expandedBar]} pointerEvents={galleryOpen ? "none" : "auto"} accessibilityElementsHidden={galleryOpen} importantForAccessibility={galleryOpen ? "no-hide-descendants" : "auto"}>
            {!expanded && <ToolbarButton icon="chevron.left" label="Back" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} />}
            <ConnectionTitle title={title} subtitle={workspace} hidden={connectionInRail || galleryOpen || previewOpen || modelOpen} style={styles.title}
              detail={agent ? <ProviderLabel harness={agent.harness} workspaceId={agent.workspaceId} parts={[workspace]} state={state} maxFontSizeMultiplier={1.2} /> : undefined}>
              <View accessible accessibilityRole="header" accessibilityLabel={agent ? `${title}, ${sessionIdentity(agent.harness, state)}` : title} style={styles.titleLine}>
                <Text style={styles.titleText} color="textStrong" numberOfLines={1} maxFontSizeMultiplier={1.2}>{title}</Text>
              </View>
            </ConnectionTitle>
            {files.length > 0 && <ToolbarButton icon="photo.on.rectangle" count={files.length} label={`Open previews, ${files.length} ${files.length === 1 ? "preview" : "previews"}`} onPress={showGallery} />}
            {(agent || createPreview || reloadMessages) && <ToolbarButton icon="ellipsis" label="Session actions" onPress={() => sessionActions.open(agent, { closeConversation: expanded ? () => router.dismissTo("/") : undefined, createPreview, reloadMessages })} />}
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
      </SafeAreaView>
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
                key={`${listGeneration.current}:${listReset}`}
                ref={listRef}
                data={messages}
                keyExtractor={(row) => row.key}
                getItemType={rowType}
                renderItem={({ item }) => <ChatRow agentId={id} row={item} showGallery={showGallery} openPreview={openPreview} />}
                ItemSeparatorComponent={Gap}
                contentContainerStyle={{ paddingHorizontal: chatPadding, paddingTop: spacing.sm, paddingBottom: spacing.xs }}
                onContentSizeChange={(_, height) => {
                  const viewport = listHeight.current;
                  const shrankPastEnd = viewport !== null && height < contentHeight.current && height < scrollOffset.current + viewport / 2;
                  contentHeight.current = height;
                  if (shrankPastEnd) {
                    scrollOffset.current = 0;
                    contentHeight.current = 0;
                    restoreOffset.current = null;
                    followEnd.current = true;
                    atBottomRef.current = true;
                    memory.offset = null;
                    setListReset((count) => count + 1);
                    return;
                  }
                  if (followEnd.current && listHeight.current !== null) void listRef.current?.scrollToOffset({ offset: Math.max(0, height - listHeight.current), animated: false });
                }}
                maintainVisibleContentPosition={{ startRenderingFromBottom: true, disabled: atBottom }}
                drawDistance={windowHeight}
                onLoad={() => {
                  const offset = restoreOffset.current;
                  if (offset !== null && !focusQuestion) void listRef.current?.scrollToOffset({ offset, animated: false });
                  else toEnd(false);
                }}
                onStartReached={() => void store.loadOlder(id)}
                onStartReachedThreshold={0.5}
                onScroll={onScroll}
                onScrollBeginDrag={() => {
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
                scrollEventThrottle={64}
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
          {dock && pending?.type === "question" && <QuestionCard key={pending.key} item={pending.item} actions={actions} {...dock} />}
          {dock && pending?.type === "approval" && <ApprovalCard key={pending.key} item={pending.item} tool={pending.tool} reviewOnDesktop={pending.reviewOnDesktop} actions={actions} {...dock} />}
          {dock && pending?.type === "plan" && <PlanCard key={pending.key} item={pending.item} actions={actions} {...dock} />}
          <View style={pending ? { display: "none" } : undefined}>
          <Composer
            agent={agent}
            initialText={draft}
            draftKey={id}
            disabled={conn !== "online" || !agent || !!pending || galleryOpen || previewOpen || modelOpen}
            modelControl={agent ? { harness: model.selection.harness, name: model.name, effort: model.effort, onPress: model.show } : undefined}
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

function ToolbarButton({ icon, label, count, onPress }: { icon: ComponentProps<typeof Icon>["name"]; label: string; count?: number; onPress?: () => void }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !onPress }} disabled={!onPress} onPress={onPress}
    style={({ pressed }) => [styles.headerButton, count !== undefined && styles.countButton, pressed && { backgroundColor: colors.pressed }]}>
    <Icon name={icon} size={20} color={onPress ? "textStrong" : "textSubtle"} />
    {count !== undefined && <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.count}>{count}</Text>}
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
