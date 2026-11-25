import { DarkTheme, DefaultTheme, SplashScreen, Stack, ThemeProvider as NavigationThemeProvider, useGlobalSearchParams, useNavigationContainerRef, useRouter, useSegments, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { Agent } from "@shared/protocol";
import { useCallback, useEffect, useMemo, useRef, type ComponentRef } from "react";
import { Linking, Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { bootstrap, store, useAppState, useConnection } from "../state/app";
import { releasePreview, useExpandedPreview } from "../state/expandedPreview";
import { applyDrop, commitPanes, PANE_MIN, paneCapacity, setDrawerOpen, setRailHidden, shownPanes, useSplitState, type DropTarget } from "../state/split";
import { loadThemeChoice, useThemeChoice } from "../state/themePrefs";
import { applySystemTheme } from "../theme/systemTheme";
import { scrim, ThemeProvider, useSchemeColors } from "../theme/theme";
import { ActionMenuHost } from "../ui/ActionMenuHost";
import { ConnectionStatusProvider } from "../ui/ConnectionTitle";
import { CrashBoundary, CrashScreen } from "../ui/CrashBoundary";
import { describeCrash, installCrashRecorder, recordCrash } from "../state/crashLog";
import { diag, diagState, installDiagLog } from "../state/diagLog";
import { foldRailWidth, FoldLayoutContext, useWindowFontScale } from "../ui/FoldLayout";
import { KeyboardSpacer } from "../ui/KeyboardSpacer";
import { SessionsList } from "../ui/SessionsList";
import { measureSplitRegion, SplitDragLayer, useSplitDropRegion } from "../ui/SplitDrag";

void SplashScreen.preventAutoHideAsync().catch(() => {});
installDiagLog();
installCrashRecorder();

export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  const report = useMemo(() => {
    const described = describeCrash("render", error);
    recordCrash(described);
    return described;
  }, [error]);
  return <View onLayout={SplashScreen.hide} style={styles.shell}><CrashScreen report={report} onRetry={() => void retry()} /></View>;
}

export default function RootLayout() {
  const themeChoice = useThemeChoice();
  const theme = useSchemeColors(themeChoice);
  const { colors, scheme } = theme;
  const navigationTheme = useMemo(() => ({
    ...(scheme === "dark" ? DarkTheme : DefaultTheme),
    colors: { primary: colors.accentText, background: colors.background, card: colors.surface, text: colors.textStrong, border: colors.separator, notification: colors.danger },
  }), [colors, scheme]);
  const router = useRouter();
  const [route] = useSegments();
  useNavigationDiag();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const { connection, bootstrapped } = useConnection();
  const { width } = useWindowDimensions();
  const fontScale = useWindowFontScale();
  const detail = route === "session" || route === "workspace" || route === "new";
  const primary = !route || detail;
  const railWidth = bootstrapped && connection ? foldRailWidth(width, fontScale) : 0;
  const expanded = primary && railWidth > 0;
  const sessionId = route === "session" ? id : undefined;
  const previewOwner = useExpandedPreview();
  const split = useSplitState();
  const agentIds = useAppState((state) => state.agents.map((agent) => agent.id).join("\n"));
  const waiting = useAppState((state) => state.agents.filter((agent) => agent.status === "waiting").length);
  const capacity = expanded && sessionId ? paneCapacity(width, fontScale) : 1;
  const panes = useMemo(() => {
    const known = new Set(agentIds.split("\n"));
    return shownPanes(split, sessionId, capacity, (paneId) => known.has(paneId));
  }, [agentIds, capacity, sessionId, split]);
  const hiddenByUser = !!sessionId && split.railHidden;
  const railDocked = !hiddenByUser && (panes.length <= 1 || width - railWidth >= panes.length * PANE_MIN);
  const railCollapsed = expanded && !railDocked;
  const drawerOpen = railCollapsed && split.drawerOpen;
  const showRail = expanded && (railDocked || drawerOpen) && (!sessionId || previewOwner !== sessionId);
  const dockedRail = showRail && railDocked;
  const missingSession = useAppState((state) => !!sessionId && state.conn === "online" &&
    !state.agents.some((agent) => agent.id === sessionId));
  const layout = useMemo(() => ({
    connectionInRail: dockedRail,
    wide: railWidth > 0,
    fontScale,
    expanded,
    railWidth: dockedRail ? railWidth : 0,
    paneWidth: dockedRail ? width - railWidth : width,
    panes,
    railCollapsed,
    waiting,
  }), [dockedRail, expanded, fontScale, panes, railCollapsed, railWidth, waiting, width]);

  const openDetail = useCallback((href: Href) => {
    if (detail) router.replace(href);
    else router.push(href);
  }, [detail, router]);

  const openSession = useCallback((nextId: string, focusQuestion: boolean) => {
    setDrawerOpen(false);
    if (route === "session" && id && panes.length > 1) {
      commitPanes(panes.includes(nextId) ? panes : panes.map((paneId) => paneId === id ? nextId : paneId), nextId);
      router.setParams({ id: nextId, focusQuestion: focusQuestion ? "1" : undefined, gallery: undefined, viewer: undefined });
      return;
    }
    if (route === "session" && id === nextId) {
      if (focusQuestion) router.setParams({ focusQuestion: "1", gallery: undefined, viewer: undefined });
      return;
    }
    openDetail({ pathname: "/session/[id]", params: focusQuestion ? { id: nextId, focusQuestion: "1" } : { id: nextId } });
  }, [id, openDetail, panes, route, router]);

  const dropInSplit = useCallback((agentId: string, target: DropTarget) => {
    setDrawerOpen(false);
    commitPanes(applyDrop(panes, agentId, target), agentId);
    router.setParams({ id: agentId, focusQuestion: undefined, gallery: undefined, viewer: undefined });
  }, [panes, router]);
  const dropRegion = useMemo(() => capacity > 1 ? { panes, capacity, drop: dropInSplit } : null, [capacity, dropInSplit, panes]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const hideRail = useCallback(() => setRailHidden(true), []);
  const splitChoices = useCallback((agent: Agent) => {
    if (!dropRegion || panes.includes(agent.id)) return [];
    if (panes.length < capacity) return [{ label: "Open in split", onPress: () => dropInSplit(agent.id, { index: Math.max(0, panes.indexOf(id ?? "")), zone: "after" }) }];
    const titles = new Map(store.getState().agents.map((known) => [known.id, known.title]));
    return panes.map((paneId, index) => ({ label: `Open in place of ${titles.get(paneId) ?? "session"}`, onPress: () => dropInSplit(agent.id, { index, zone: "center" }) }));
  }, [capacity, dropInSplit, dropRegion, id, panes]);
  useSplitDropRegion(dropRegion, closeDrawer);
  const detailRef = useRef<ComponentRef<typeof View>>(null);

  useEffect(() => {
    if (!expanded || !sessionId || !missingSession) return;
    let active = true;
    const previousSnapshot = store.getState().syncedAt;
    void store.sync().then(() => {
      const snapshot = store.getState();
      if (!active || snapshot.syncedAt === previousSnapshot || snapshot.agents.some((agent) => agent.id === sessionId)) return;
      releasePreview(sessionId);
      diag(`nav home: session ${sessionId.slice(0, 8)} missing after sync`);
      router.dismissTo("/");
    });
    return () => { active = false; };
  }, [expanded, missingSession, router, sessionId]);

  useEffect(() => {
    void bootstrap();
    void loadThemeChoice();
  }, []);

  useEffect(() => {
    if (themeChoice !== null) void applySystemTheme(colors.background, scheme);
  }, [colors.background, scheme, themeChoice]);

  diagState("layout", `route=${route ?? "index"} id=${id ?? "-"} theme=${themeChoice} boot=${bootstrapped} paired=${!!connection} width=${Math.round(width)} rail=${railWidth} panes=${panes.length}`);
  if (themeChoice === null) return null;
  const pushAnimation = expanded ? "none" : Platform.OS === "android" ? "fade_from_bottom" : "default";
  return (
    <ThemeProvider value={theme}>
      <CrashBoundary>
      <NavigationThemeProvider value={navigationTheme}>
      <SafeAreaProvider>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <ConnectionStatusProvider>
        <FoldLayoutContext.Provider value={layout}>
          <View onLayout={SplashScreen.hide} style={[styles.shell, { backgroundColor: colors.background }]}>
            <SplitDragLayer>
            <View style={styles.panes}>
            {drawerOpen && <Pressable accessibilityLabel="Close sessions" onPress={closeDrawer} style={[StyleSheet.absoluteFill, styles.drawerScrim]} />}
            {railWidth > 0 && (
              <SafeAreaView edges={["top", "left", "bottom"]} pointerEvents={showRail ? "auto" : "none"}
                accessibilityElementsHidden={!showRail} importantForAccessibility={showRail ? "auto" : "no-hide-descendants"}
                style={[styles.rail, railCollapsed && [styles.drawer, { backgroundColor: colors.background }], { width: railWidth, display: showRail ? "flex" : "none", borderRightColor: colors.separator }]}>
                <SessionsList docked sessionId={sessionId} workspaceId={route === "workspace" ? id : undefined}
                  paneWidth={railWidth} onOpenSession={openSession} splitChoices={splitChoices}
                  onHide={dockedRail && sessionId ? hideRail : undefined} />
              </SafeAreaView>
            )}
            <View ref={detailRef} style={styles.detail} onLayout={() => measureSplitRegion(detailRef.current)}>
              <SafeAreaProvider style={styles.detail}>
                <Stack
                  screenListeners={transitionLog}
                  screenLayout={({ route: screen, children }) => screen.name === "settings" || screen.name === "connect"
                    ? <View style={styles.form}>{children}</View>
                    : <>{children}</>}
                  screenOptions={{
                    headerStyle: { backgroundColor: colors.background },
                    headerTintColor: colors.accentText,
                    headerTitleStyle: { color: colors.textStrong },
                    headerShadowVisible: false,
                    contentStyle: { backgroundColor: colors.background },
                  }}
                >
                  <Stack.Screen name="index" options={{ title: "Lodestar", headerShown: railWidth === 0 && Platform.OS !== "android" }} />
                  <Stack.Screen name="session/[id]" dangerouslySingular={singleSessionSlot} options={({ route }) => ({ title: "", headerBackButtonDisplayMode: "minimal", animation: (route.params as { started?: string } | undefined)?.started ? "none" : pushAnimation })} />
                  <Stack.Screen name="mate" options={{ title: "", headerBackButtonDisplayMode: "minimal" }} />
                  <Stack.Screen name="workspace/[id]" options={{ title: "", headerBackButtonDisplayMode: "minimal" }} />
                  <Stack.Screen name="add-workspace" options={{ title: "Add workspace", presentation: "modal" }} />
                  <Stack.Screen name="new" options={{ title: "New session", animation: pushAnimation }} />
                  <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
                  <Stack.Screen name="connect" options={{ title: "Lodestar", headerBackVisible: false, gestureEnabled: false }} />
                  <Stack.Screen name="scan" options={{ title: "Scan QR code", presentation: "modal" }} />
                  <Stack.Screen name="pair" options={{ headerShown: false }} />
                </Stack>
              </SafeAreaProvider>
            </View>
            </View>
            </SplitDragLayer>
          </View>
          {expanded && <KeyboardSpacer keyboardOnly />}
          <ActionMenuHost />
        </FoldLayoutContext.Provider>
        </ConnectionStatusProvider>
      </SafeAreaProvider>
      </NavigationThemeProvider>
      </CrashBoundary>
    </ThemeProvider>
  );
}

const singleSessionSlot = () => "session";

type NavState = { index?: number; routes: { name: string; params?: object; state?: NavState }[] };

function innerStack(state: NavState | undefined): NavState["routes"] {
  if (!state) return [];
  const focused = state.routes[state.index ?? state.routes.length - 1];
  return focused?.state ? innerStack(focused.state) : state.routes;
}

function useNavigationDiag() {
  const navigation = useNavigationContainerRef();
  useEffect(() => {
    let shown = "";
    const offState = navigation.addListener("state", ({ data }) => {
      const routes = innerStack(data.state).map((route) => {
        const id = (route.params as { id?: string } | undefined)?.id;
        return id ? `${route.name}:${id.slice(0, 8)}` : route.name;
      }).join(">");
      if (routes === shown) return;
      shown = routes;
      diag(`nav stack ${routes}`);
    });
    const link = Linking.addEventListener("url", ({ url }) => diag(`link ${url}`));
    void Linking.getInitialURL().then((url) => diag(`initial link ${url ?? "none"}`)).catch(() => {});
    return () => {
      offState();
      link.remove();
    };
  }, [navigation]);
}

const transitionLog = ({ route }: { route: { name: string } }) => ({
  transitionStart: (event: { data?: { closing?: boolean } }) => diag(`transition start ${route.name}${event.data?.closing ? " closing" : ""}`),
  transitionEnd: (event: { data?: { closing?: boolean } }) => diag(`transition end ${route.name}${event.data?.closing ? " closing" : ""}`),
});

const styles = StyleSheet.create({
  shell: { flex: 1 },
  panes: { flex: 1, flexDirection: "row" },
  detail: { flex: 1, minWidth: 0 },
  form: { flex: 1, width: "100%", maxWidth: 560, alignSelf: "center" },
  rail: { borderRightWidth: 1 },
  drawer: { position: "absolute", top: 0, bottom: 0, left: 0, zIndex: 2, elevation: 2 },
  drawerScrim: { zIndex: 1, backgroundColor: scrim },
});
