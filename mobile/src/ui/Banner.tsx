import { useHeaderHeight } from "expo-router/react-navigation";
import { Platform, StyleSheet, View } from "react-native";
import type { ConnStatus } from "../net/rpc";
import { spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Text } from "./Text";

// 연결 상태 띠(안드로이드의 헤더는 불투명이라 내용이 헤더 아래에서 시작한다. 목록 위에 겹치면 첫 줄을 가리므로 안드로이드는 흐름 안에 둬서 목록을 아래로 민다). 연결되어 있으면 아무것도 그리지 않는다. 투명 헤더 아래에서 목록 위에 겹쳐 떠 있다(목록은 헤더 높이만큼 스스로 비워 두므로 띠가 레이아웃을 밀지 않는다).
export function ConnectionBanner({ status, hostName, onRepair }: { status: ConnStatus; hostName: string | null; onRepair?: () => void }) {
  const colors = useColors();
  const headerHeight = useHeaderHeight();
  if (status === "online") return null;
  const unauthorized = status === "unauthorized";
  const message = unauthorized ? `This phone was removed from ${hostName ?? "your Mac"}. Pair it again to continue.` : status === "idle" ? "Not connected" : status === "connecting" ? "Connecting to your Mac…" : "Can't reach your Mac. Showing saved sessions and retrying.";
  return (
    <View accessibilityRole="alert" style={[styles.wrap, Platform.OS === "android" ? styles.inFlow : { top: headerHeight }, { backgroundColor: colors.surface, borderBottomColor: unauthorized ? colors.danger : colors.warning }]}>
      <Text variant="secondary" color={unauthorized ? "danger" : "text"} style={{ flex: 1 }}>{message}</Text>
      {unauthorized && onRepair && <Button title="Pair" kind="primary" onPress={onRepair} style={{ minHeight: 44, paddingHorizontal: spacing.lg }} />}
    </View>
  );
}

const styles = StyleSheet.create({ inFlow: { position: "relative", top: 0 }, wrap: { position: "absolute", left: 0, right: 0, zIndex: 10, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 2 } });
