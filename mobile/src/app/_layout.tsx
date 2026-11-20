import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { bootstrap } from "../state/app";
import { ThemeProvider, useSchemeColors } from "../theme/theme";
import { ActionMenuHost } from "../ui/ActionMenuHost";

export default function RootLayout() {
  const { colors, scheme } = useSchemeColors();
  useEffect(() => {
    void bootstrap();
  }, []);
  return (
    <ThemeProvider value={colors}>
      <SafeAreaProvider>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.accentText,
            headerTitleStyle: { color: colors.textStrong },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" options={{ title: "Sessions" }} />
          <Stack.Screen name="session/[id]" options={{ title: "", headerBackButtonDisplayMode: "minimal" }} />
          <Stack.Screen name="workspace/[id]" options={{ title: "", headerBackButtonDisplayMode: "minimal" }} />
          <Stack.Screen name="add-workspace" options={{ title: "Add workspace", presentation: "modal" }} />
          <Stack.Screen name="new" options={{ title: "New session", presentation: "modal" }} />
          <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
          <Stack.Screen name="connect" options={{ title: "Connect to your Mac", headerBackVisible: false, gestureEnabled: false }} />
          <Stack.Screen name="scan" options={{ title: "Scan QR code", presentation: "modal" }} />
          <Stack.Screen name="pair" options={{ headerShown: false }} />
        </Stack>
        <ActionMenuHost />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
