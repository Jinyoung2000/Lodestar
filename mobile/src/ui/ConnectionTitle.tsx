import { useRouter } from "expo-router";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import type { ConnStatus } from "../net/rpc";
import { client, useAppState, useConnection } from "../state/app";
import { Text } from "./Text";

const RETRY_STATUS_DELAY_MS = 800;
const ConnectionStatusContext = createContext<ConnStatus>("online");

export function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const status = useAppState((s) => s.conn);
  const retrying = status === "connecting" || status === "offline";
  const [wasRetrying, setWasRetrying] = useState(retrying);
  const [delayPassed, setDelayPassed] = useState(false);
  if (wasRetrying !== retrying) {
    setWasRetrying(retrying);
    setDelayPassed(false);
  }
  useEffect(() => {
    if (!retrying) return;
    const timer = setTimeout(() => setDelayPassed(true), RETRY_STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [retrying]);
  const visibleStatus = retrying && !delayPassed ? "online" : status;
  return <ConnectionStatusContext.Provider value={visibleStatus}>{children}</ConnectionStatusContext.Provider>;
}

export function useReconnect() {
  const router = useRouter();
  const { connection } = useConnection();
  const status = useAppState((s) => s.conn);
  return () => {
    if (status === "unauthorized" || !connection) router.replace("/connect");
    else if (status === "idle") client.configure(connection);
    else void client.resume();
  };
}

const CONNECTION_LABELS: Record<ConnStatus, string | undefined> = {
  online: undefined,
  idle: "Connect to Mac",
  connecting: "Reconnecting…",
  offline: "Offline · Reconnect",
  unauthorized: "Pair again",
};

export function ConnectionTitle({ children, title, subtitle, hidden, maxFontSizeMultiplier = 1.2, style }: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  hidden?: boolean;
  maxFontSizeMultiplier?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const status = useContext(ConnectionStatusContext);
  const reconnect = useReconnect();
  const label = hidden ? undefined : CONNECTION_LABELS[status];
  const canReconnect = !!label && status !== "connecting";
  const text = label ?? subtitle;
  const content = (
    <>
      {children}
      {!!text && <Text
        accessibilityLiveRegion={label ? "polite" : "none"}
        variant="caption"
        color={canReconnect ? "accentText" : "textMuted"}
        numberOfLines={1}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
      >{text}</Text>}
    </>
  );
  if (!canReconnect) return <View style={[styles.title, style]}>{content}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}, ${label}`}
      accessibilityHint={status === "unauthorized" ? "This phone was removed from your Mac" : undefined}
      onPress={reconnect} style={[styles.title, style]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { minWidth: 0, alignSelf: "stretch", justifyContent: "center" },
});
