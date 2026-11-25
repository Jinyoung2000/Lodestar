import type { MobileWalkthrough } from "@shared/mobile";
import type { WalkthroughRow, WalkthroughSlide } from "@shared/walkthrough";
import { Suspense, use, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { client } from "../state/app";
import { radius, spacing, useColors } from "../theme/theme";
import { Button } from "./Button";
import { Text } from "./Text";

type Loaded = MobileWalkthrough | { error: string };

const LOADED_LIMIT = 24;
const loads = new Map<string, Promise<Loaded>>();

function loadWalkthrough(agentId: string, itemId: string, source: string, attempt: number): Promise<Loaded> {
  const key = `${attempt}\n${agentId}\n${itemId}\n${source}`;
  const known = loads.get(key);
  if (known) return known;
  const loading = client.call("mobile.walkthrough", { agentId, itemId, source }).catch((error: unknown): Loaded => ({ error: error instanceof Error ? error.message : String(error) }));
  loads.set(key, loading);
  if (loads.size > LOADED_LIMIT) loads.delete(loads.keys().next().value as string);
  return loading;
}

export type WalkthroughBlockProps = { agentId: string; itemId: string; source: string; marginBottom: number; renderCode: (marginBottom: number) => ReactNode };

export function WalkthroughBlock({ agentId, itemId, source, marginBottom, renderCode }: WalkthroughBlockProps) {
  const colors = useColors();
  const [attempt, setAttempt] = useState(0);
  return (
    <View style={[styles.card, { marginBottom, backgroundColor: colors.surfaceBase, borderColor: colors.separator }]}>
      <Suspense fallback={<Loading />}>
        <Steps load={loadWalkthrough(agentId, itemId, source, attempt)} onRetry={() => setAttempt((n) => n + 1)} renderCode={renderCode} />
      </Suspense>
    </View>
  );
}

function Loading() {
  return (
    <View style={styles.head}>
      <Text variant="caption" color="textMuted">Walkthrough</Text>
    </View>
  );
}

function Steps({ load, onRetry, renderCode }: { load: Promise<Loaded>; onRetry: () => void; renderCode: (marginBottom: number) => ReactNode }) {
  const result = use(load);
  const [index, setIndex] = useState(0);
  if ("error" in result) {
    if (result.error.includes("mobile.walkthrough")) return <>{renderCode(0)}</>;
    return (
      <View style={styles.failed}>
        <Text variant="secondary" color="textMuted">{result.error}</Text>
        <Button title="Try again" kind="plain" onPress={onRetry} />
      </View>
    );
  }
  const count = result.slides.length;
  if (!count) return <>{renderCode(0)}</>;
  const current = Math.min(index, count - 1);
  return (
    <>
      <View style={styles.head}>
        <Text variant="caption" color="textMuted">Walkthrough</Text>
        <Text variant="caption" color="textMuted">{`${current + 1} of ${count}`}</Text>
      </View>
      {count > 1 && <Rail count={count} current={current} onPick={setIndex} />}
      <Slide slide={result.slides[current]} />
      <View style={styles.foot}>
        <Button title="Back" disabled={current === 0} onPress={() => setIndex(current - 1)} flex />
        <Button title="Next" kind="primary" disabled={current === count - 1} onPress={() => setIndex(current + 1)} flex />
      </View>
    </>
  );
}

function Rail({ count, current, onPick }: { count: number; current: number; onPick: (index: number) => void }) {
  const colors = useColors();
  return (
    <View style={styles.rail}>
      {Array.from({ length: count }, (_, i) => (
        <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Go to step ${i + 1}`} onPress={() => onPick(i)} hitSlop={{ top: 12, bottom: 12 }} style={styles.tickHit}>
          <View style={[styles.tick, { backgroundColor: i === current ? colors.accent : i < current ? colors.textSubtle : colors.border }]} />
        </Pressable>
      ))}
    </View>
  );
}

function Slide({ slide }: { slide: WalkthroughSlide }) {
  const colors = useColors();
  return (
    <View>
      {!!slide.step.note && (
        <Text variant="bodyStrong" color="textStrong" style={styles.note}>
          {noteParts(slide.step.note, colors.inlineCodeText)}
        </Text>
      )}
      <Text variant="mono" color="accentText" numberOfLines={1} style={styles.path}>
        {slide.line === null ? slide.step.path : `${slide.step.path}:${slide.line}`}
      </Text>
      {slide.missing && (
        <Text variant="caption" color="textMuted" style={styles.missing}>
          {slide.missing === "file" ? "This file is not in the folder yet. Only the proposed lines are shown." : "The file is shorter than this line. Only the proposed lines are shown."}
        </Text>
      )}
      {slide.rows.length > 0 && (
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} style={[styles.code, { backgroundColor: colors.codeBackground, borderColor: colors.separator }]} contentContainerStyle={styles.codeContent}>
          <View style={styles.lines}>
            {slide.rows.map((row, i) => (
              <Row key={i} row={row} />
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const SIGN: Record<WalkthroughRow["kind"], string> = { context: " ", focus: " ", removed: "-", added: "+" };

function Row({ row }: { row: WalkthroughRow }) {
  const colors = useColors();
  const background = row.kind === "added" ? colors.diffAdd : row.kind === "removed" ? colors.diffDelete : row.kind === "focus" ? colors.selected : "transparent";
  return (
    <View style={[styles.row, { backgroundColor: background }]}>
      <Text variant="mono" color={row.kind === "context" ? "textSubtle" : "textMuted"} style={styles.number}>
        {row.line ?? ""}
      </Text>
      <Text variant="mono" color="textSubtle" style={styles.sign}>
        {SIGN[row.kind]}
      </Text>
      <Text variant="mono" color={row.kind === "context" ? "textMuted" : "text"} selectable style={styles.lineText}>
        {row.text || " "}
      </Text>
    </View>
  );
}

function noteParts(note: string, codeColor: string): ReactNode[] {
  return note.split(/(`[^`]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <Text key={i} variant="mono" style={{ color: codeColor }}>
        {part.slice(1, -1)}
      </Text>
    ) : (
      part
    ),
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  head: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  rail: { flexDirection: "row", gap: 3, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  tickHit: { flex: 1, paddingVertical: spacing.xs },
  tick: { height: 3, borderRadius: 2 },
  note: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  path: { paddingHorizontal: spacing.md, paddingTop: 2, paddingBottom: spacing.sm, fontSize: 12 },
  missing: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  code: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  codeContent: { flexGrow: 1, paddingVertical: spacing.xs },
  lines: { flexGrow: 1 },
  row: { flexDirection: "row", paddingRight: spacing.md },
  number: { width: 40, textAlign: "right", fontSize: 12 },
  sign: { width: 20, textAlign: "center", fontSize: 12 },
  lineText: { fontSize: 12 },
  foot: { flexDirection: "row", gap: spacing.sm, padding: spacing.sm },
  failed: { padding: spacing.md, gap: spacing.sm },
});
