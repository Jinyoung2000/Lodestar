import { DarkTheme, DefaultTheme, SplashScreen, Stack, ThemeProvider as NavigationThemeProvider, useGlobalSearchParams, useRouter, useSegments, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { bootstrap, store, useAppState, useConnection } from "../state/app";
import { releasePreview, useExpandedPreview } from "../state/expandedPreview";
import { loadThemeChoice, useThemeChoice } from "../state/themePrefs";
import { applySystemTheme } from "../theme/systemTheme";
import { ThemeProvider, useSchemeColors } from "../theme/theme";
import { ActionMenuHost } from "../ui/ActionMenuHost";
import { foldRailWidth, FoldLayoutContext, useWindowFontScale } from "../ui/FoldLayout";
import { KeyboardSpacer } from "../ui/KeyboardSpacer";
import { ConnectionBanner } from "../ui/Banner";
import { SessionsList } from "../ui/SessionsList";

void SplashScreen.preventAutoHideAsync().catch(() => {});

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
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const offline = useAppState((state) => state.conn !== "online");
  const { connection, bootstrapped } = useConnection();
  const { width } = useWindowDimensions();
  const fontScale = useWindowFontScale();
  const detail = route === "session" || route === "workspace" || route === "new";
  const primary = !route || detail;
  const railWidth = bootstrapped && connection ? foldRailWidth(width, fontScale) : 0;
  const expanded = primary && railWidth > 0;
  const sessionId = route === "session" ? id : undefined;
  const previewOwner = useExpandedPreview();
  const showRail = expanded && (!sessionId || previewOwner !== sessionId);
  const missingSession = useAppState((state) => !!sessionId && state.conn === "online" &&
    !state.agents.some((agent) => agent.id === sessionId));
  const sharedConnectionStrip = showRail && offline;
  const layout = useMemo(() => ({
    sharedConnectionStrip,
    wide: railWidth > 0,
    fontScale,
    expanded,
    railWidth: showRail ? railWidth : 0,
    paneWidth: showRail ? width - railWidth : width,
  }), [expanded, fontScale, railWidth, sharedConnectionStrip, showRail, width]);

  const openDetail = useCallback((href: Href) => {
    if (detail) router.replace(href);
    else router.push(href);
  }, [detail, router]);

  const openSession = useCallback((nextId: string, focusQuestion: boolean) => {
    if (route === "session" && id === nextId) {
      if (focusQuestion) router.setParams({ focusQuestion: "1", gallery: undefined, viewer: undefined });
      return;
    }
    openDetail({ pathname: "/session/[id]", params: focusQuestion ? { id: nextId, focusQuestion: "1" } : { id: nextId } });
  }, [id, openDetail, route, router]);

  useEffect(() => {
    if (!expanded || !sessionId || !missingSession) return;
    let active = true;
    const previousSnapshot = store.getState().syncedAt;
    void store.sync().then(() => {
      const snapshot = store.getState();
      if (!active || snapshot.syncedAt === previousSnapshot || snapshot.agents.some((agent) => agent.id === sessionId)) return;
      releasePreview(sessionId);
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

  if (themeChoice === null) return null;
  return (
    <ThemeProvider value={theme}>
      <NavigationThemeProvider value={navigationTheme}>
      <SafeAreaProvider>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <FoldLayoutContext.Provider value={layout}>
          <View onLayout={SplashScreen.hide} style={[styles.shell, { backgroundColor: colors.background }]}>
            {sharedConnectionStrip && <SafeAreaView edges={["top", "left", "right"]}><ConnectionBanner /></SafeAreaView>}
            <View style={styles.panes}>
            {railWidth > 0 && (
              <SafeAreaView edges={sharedConnectionStrip ? ["left", "bottom"] : ["top", "left", "bottom"]} pointerEvents={showRail ? "auto" : "none"}
                accessibilityElementsHidden={!showRail} importantForAccessibility={showRail ? "auto" : "no-hide-descendants"}
                style={[styles.rail, { width: railWidth, display: showRail ? "flex" : "none", borderRightColor: colors.separator }]}>
                <SessionsList docked sessionId={sessionId} workspaceId={route === "workspace" ? id : undefined}
                  paneWidth={railWidth} onOpenSession={openSession} />
              </SafeAreaView>
            )}
            <View style={styles.detail}>
              <SafeAreaProvider style={styles.detail}>
                <Stack
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
                  <Stack.Screen name="index" options={{ title: "Lodestar", headerShown: railWidth === 0 }} />
                  <Stack.Screen name="session/[id]" options={{ title: "", headerBackButtonDisplayMode: "minimal", animation: expanded ? "none" : "default" }} />
                  <Stack.Screen name="workspace/[id]" options={{ title: "", headerBackButtonDisplayMode: "minimal" }} />
                  <Stack.Screen name="add-workspace" options={{ title: "Add workspace", presentation: "modal" }} />
                  <Stack.Screen name="new" options={{ title: "New session", animation: expanded ? "none" : "default" }} />
                  <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
                  <Stack.Screen name="connect" options={{ title: "Lodestar", headerBackVisible: false, gestureEnabled: false }} />
                  <Stack.Screen name="scan" options={{ title: "Scan QR code", presentation: "modal" }} />
                  <Stack.Screen name="pair" options={{ headerShown: false }} />
                </Stack>
              </SafeAreaProvider>
            </View>
            </View>
          </View>
          {expanded && <KeyboardSpacer keyboardOnly />}
          <ActionMenuHost />
        </FoldLayoutContext.Provider>
      </SafeAreaProvider>
      </NavigationThemeProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  panes: { flex: 1, flexDirection: "row" },
  detail: { flex: 1, minWidth: 0 },
  form: { flex: 1, width: "100%", maxWidth: 560, alignSelf: "center" },
  rail: { borderRightWidth: 1 },
});
