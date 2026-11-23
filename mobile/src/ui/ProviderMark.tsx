import { Image, StyleSheet, View } from "react-native";
import type { Harness } from "@shared/protocol";
import type { SessionState } from "../logic/agents";
import { useColors } from "../theme/theme";
import type { PaletteName } from "../theme/tokens.generated";
import { Text } from "./Text";
import { WorkspaceIcon } from "./WorkspaceIcon";

const MARKS = {
  claude: require("../../assets/project-marks/claude.png"),
  codex: require("../../assets/project-marks/codex.png"),
};

export const PROVIDER_NAMES: Record<Harness, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
const STATES: Record<SessionState, string> = { waiting: "Needs your reply", error: "Stopped with an error", running: "Working", unread: "Unread", idle: "Idle" };
export const STATE_LABEL: Record<SessionState, string | null> = { waiting: "Needs your reply", error: "Stopped with an error", running: "Working", unread: null, idle: null };
export const STATE_COLOR: Record<SessionState, PaletteName> = { waiting: "warning", error: "danger", running: "accentText", unread: "textMuted", idle: "textMuted" };

export function sessionIdentity(harness: Harness | undefined, state: SessionState) {
  return `${PROVIDER_NAMES[harness ?? "claude"]}, ${STATES[state]}`;
}

const MARK_COLOR: Record<Harness, PaletteName> = { claude: "providerClaude", codex: "providerCodex", antigravity: "providerAntigravity" };

export function ProviderMark({ harness = "claude", size = 16 }: { harness?: Harness; state?: SessionState; selected?: boolean; size?: number }) {
  const colors = useColors();
  const color = colors[MARK_COLOR[harness]];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.mark, { width: size, height: size }]}>
      {harness === "antigravity"
        ? <View style={[styles.letterBox, { borderColor: color, width: size, height: size, borderRadius: Math.max(2, size / 5) }]}>
          <Text allowFontScaling={false} style={[styles.letter, { color, fontSize: Math.round(size * 0.68), lineHeight: Math.round(size * 0.82) }]}>A</Text>
        </View>
        : <Image accessible={false} importantForAccessibility="no" source={MARKS[harness]} resizeMode="contain" style={{ width: size, height: size, tintColor: color }} />}
    </View>
  );
}

export function ProviderLabel({ harness, workspaceId, parts = [], state, selected, maxFontSizeMultiplier = 1.6 }: {
  workspaceId?: string | null; harness?: Harness; parts?: (string | null | undefined)[]; state?: SessionState; selected?: boolean; maxFontSizeMultiplier?: number;
}) {
  const label = state ? STATE_LABEL[state] : null;
  const rest = parts.filter((part): part is string => !!part);
  if (!harness && rest.length === 0 && !label) return null;
  return (
    <View style={styles.label}>
      {harness && <ProviderMark harness={harness} size={14} selected={selected} />}
      {rest.length > 0 && <WorkspaceIcon workspaceId={workspaceId} size={14} />}
      <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.labelText}>
        {rest.join(" · ")}
        {label && state ? <>
          {rest.length > 0 && <Text variant="caption" color="textSubtle" maxFontSizeMultiplier={maxFontSizeMultiplier}>{" · "}</Text>}
          <Text variant="caption" color={STATE_COLOR[state]} maxFontSizeMultiplier={maxFontSizeMultiplier} style={styles.state}>{label}</Text>
        </> : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { justifyContent: "center", alignItems: "center" },
  letterBox: { borderWidth: 1, alignItems: "center", justifyContent: "center" },
  letter: { fontWeight: "700" },
  label: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  labelText: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  state: { fontWeight: "600" },
});
