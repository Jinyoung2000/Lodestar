import { StyleSheet, View } from "react-native";
import type { Harness } from "@shared/protocol";
import type { SessionState } from "../logic/agents";
import { useColors } from "../theme/theme";
import { ProjectIcon } from "./ProjectIcon";
import { Text } from "./Text";

const PROVIDERS: Record<Harness, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
const STATES: Record<SessionState, string> = { waiting: "Needs your reply", error: "Stopped with an error", running: "Working", unread: "Unread", idle: "Idle" };

export function sessionIdentity(harness: Harness | undefined, state: SessionState) {
  return `${PROVIDERS[harness ?? "claude"]}, ${STATES[state]}`;
}

export function ProviderMark({ harness = "claude", state, selected = false }: { harness?: Harness; state: SessionState; selected?: boolean }) {
  const colors = useColors();
  const color = selected ? colors.textStrong : colors.textMuted;
  const dot = state === "running" ? colors.running : state === "waiting" ? colors.warning : state === "error" ? colors.danger : state === "unread" ? colors.unread : null;

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.mark}>
      {harness === "antigravity"
        ? <View style={[styles.letterBox, { borderColor: color }]}><Text allowFontScaling={false} style={[styles.letter, { color }]}>A</Text></View>
        : <ProjectIcon mark={harness} size={16} strong={selected} />}
      {dot && <View style={[styles.dot, { borderColor: dot, backgroundColor: state === "running" ? colors.surface : dot }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { width: 16, height: 16, justifyContent: "center", alignItems: "center" },
  letterBox: { width: 16, height: 16, borderWidth: 1, borderRadius: 3, alignItems: "center", justifyContent: "center" },
  letter: { fontSize: 11, lineHeight: 13, fontWeight: "700" },
  dot: { position: "absolute", right: -2, bottom: -1, width: 6, height: 6, borderRadius: 3, borderWidth: 1.5 },
});
