import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useSyncExternalStore, type ComponentRef, type ReactNode } from "react";
import { Animated, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dropTargetAt, type DropTarget } from "../state/split";
import { radius, spacing, useColors, withAlpha } from "../theme/theme";
import { Text } from "./Text";

export type DragSource = { agentId: string; title: string };
export type DropRegion = { panes: readonly string[]; capacity: number; drop: (agentId: string, target: DropTarget) => void };
type Rect = { x: number; y: number; width: number; height: number };
type DragView = { source: DragSource | null; target: DropTarget | null };

let region: DropRegion | null = null;
let regionRect: Rect | null = null;
let layerOrigin = { x: 0, y: 0, width: 0 };
const GHOST_WIDTH = 280;
const GHOST_LEAD = 24;
const GHOST_LIFT = 56;
let armed: { source: DragSource; fallback?: () => void; anchor?: { x: number; y: number } } | null = null;
const DRAG_SLOP = 8;
let dragging = false;
let view: DragView = { source: null, target: null };
let onDragStart: (() => void) | null = null;
const listeners = new Set<() => void>();

function setView(next: DragView) {
  if (next.source === view.source && next.target?.index === view.target?.index && next.target?.zone === view.target?.zone) return;
  view = next;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function useSplitDrag() {
  return useSyncExternalStore(subscribe, () => view);
}

export function useSplitDropRegion(next: DropRegion | null, startDrag: () => void) {
  useEffect(() => {
    region = next;
    onDragStart = startDrag;
    return () => {
      if (region === next) region = null;
      if (onDragStart === startDrag) onDragStart = null;
    };
  }, [next, startDrag]);
}

export function measureSplitRegion(target: ComponentRef<typeof View> | null) {
  target?.measureInWindow((x, y, width, height) => { regionRect = { x, y, width, height }; });
}

export function canDragToSplit() {
  return region !== null && region.capacity > 1;
}

export function armSplitDrag(source: DragSource, fallback?: () => void) {
  if (!canDragToSplit()) {
    fallback?.();
    return;
  }
  armed = { source, fallback };
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

export function endSplitPress() {
  if (!armed || dragging) return;
  const fallback = armed.fallback;
  armed = null;
  fallback?.();
}

function ghostAt(x: number, y: number) {
  const left = Math.min(x - layerOrigin.x - GHOST_LEAD, layerOrigin.width - GHOST_WIDTH - spacing.sm);
  return { x: Math.max(spacing.sm, left), y: Math.max(spacing.sm, y - layerOrigin.y - GHOST_LIFT) };
}

function targetAt(x: number, y: number, agentId: string) {
  if (!region || !regionRect || y < regionRect.y || y > regionRect.y + regionRect.height) return null;
  return dropTargetAt(x, regionRect.x, regionRect.width, region.panes, agentId, region.capacity);
}

export function SplitDragLayer({ children }: { children: ReactNode }) {
  const root = useRef<ComponentRef<typeof View>>(null);
  const ghost = useMemo(() => new Animated.ValueXY(), []);
  const responder = useMemo(() => {
    const finish = () => {
      armed = null;
      dragging = false;
      setView({ source: null, target: null });
    };
    const point = (event: GestureResponderEvent) => ({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
    return {
      onMoveShouldSetResponderCapture: (event: GestureResponderEvent) => {
        if (!armed) return false;
        const at = point(event);
        if (!armed.anchor) {
          armed.anchor = at;
          return false;
        }
        return Math.hypot(at.x - armed.anchor.x, at.y - armed.anchor.y) > DRAG_SLOP;
      },
      onResponderTerminationRequest: () => false,
      onResponderGrant: (event: GestureResponderEvent) => {
        if (!armed) return;
        dragging = true;
        onDragStart?.();
        const { x, y } = point(event);
        ghost.setValue(ghostAt(x, y));
        setView({ source: armed.source, target: null });
      },
      onResponderMove: (event: GestureResponderEvent) => {
        const source = armed?.source;
        if (!source) return;
        const { x, y } = point(event);
        ghost.setValue(ghostAt(x, y));
        setView({ source, target: targetAt(x, y, source.agentId) });
      },
      onResponderRelease: (event: GestureResponderEvent) => {
        const source = armed?.source;
        const { x, y } = point(event);
        const target = source ? targetAt(x, y, source.agentId) : null;
        const drop = region?.drop;
        finish();
        if (source && target && drop) drop(source.agentId, target);
      },
      onResponderTerminate: finish,
    };
  }, [ghost]);

  return <View ref={root} style={styles.fill} {...responder}
    onLayout={() => root.current?.measureInWindow((x, y, width) => { layerOrigin = { x, y, width }; })}>
    {children}
    <DragOverlay ghost={ghost} />
  </View>;
}

function DragOverlay({ ghost }: { ghost: Animated.ValueXY }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { source, target } = useSplitDrag();
  if (!source) return null;
  const rect = regionRect;
  const origin = layerOrigin;
  const count = region?.panes.length ?? 0;
  const zone = target && rect && count > 0 ? zoneRect(rect, count, target, insets) : null;
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    {zone && <View style={[styles.zone, {
      left: zone.x - origin.x, top: zone.y - origin.y, width: zone.width, height: zone.height,
      backgroundColor: withAlpha(colors.accent, 0.16), borderColor: colors.accentText,
    }]} />}
    <Animated.View style={[styles.ghost, { backgroundColor: colors.overlay, borderColor: colors.border, transform: ghost.getTranslateTransform() }]}>
      <Text variant="secondary" color="textStrong" numberOfLines={1} style={styles.ghostText}>{source.title}</Text>
    </Animated.View>
  </View>;
}

function zoneRect(rect: Rect, count: number, target: DropTarget, insets: { top: number; bottom: number }): Rect {
  const paneWidth = rect.width / count;
  const inset = spacing.sm;
  const left = rect.x + target.index * paneWidth;
  const half = target.zone === "center" ? paneWidth : paneWidth / 2;
  const x = target.zone === "after" ? left + paneWidth / 2 : left;
  const top = Math.max(rect.y, insets.top) + inset;
  const bottom = rect.y + rect.height - insets.bottom - inset;
  return { x: x + inset, y: top, width: half - inset * 2, height: bottom - top };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  zone: { position: "absolute", borderWidth: 2, borderRadius: radius.md },
  ghost: { position: "absolute", left: 0, top: 0, maxWidth: GHOST_WIDTH, minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.lg, borderRadius: radius.pill, borderWidth: 1 },
  ghostText: { fontWeight: "600" },
});
