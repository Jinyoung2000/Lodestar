import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import { usePathname, useRouter } from "expo-router";
import * as Updates from "expo-updates";
import { useRef, useState, type ReactNode } from "react";
import { Modal, Platform, PixelRatio, Pressable, StyleSheet, TextInput, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PhoneElement, PhoneFeedbackRequest } from "@shared/mobile";
import type { ImageRef } from "@shared/protocol";
import { describeTarget, elementTitle } from "../logic/feedbackTarget";
import { useAppState, store } from "../state/app";
import { uploadPhoto } from "../state/attach";
import { diag } from "../state/diagLog";
import { MIN_TOUCH, radius, spacing, useColors, useScheme, withAlpha } from "../theme/theme";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { KeyboardSpacer } from "./KeyboardSpacer";
import { Text } from "./Text";

type Capture = { uri: string; width: number; height: number };
const screenCapture = Platform.OS === "android"
  ? requireOptionalNativeModule<{ captureWindowAsync(): Promise<Capture | null> }>("LodestarScreenCapture")
  : null;

type Phase =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "marking"; element: PhoneElement }
  | { kind: "writing"; element: PhoneElement; screenshot: Promise<ImageRef | null> };

type FeedbackLayerProps = { children: ReactNode };

const RING = 28;

export function FeedbackLayer({ children }: FeedbackLayerProps) {
  const operator = useAppState((state) => state.operator && state.conn === "online");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const pathname = usePathname();
  const picking = phase.kind === "picking";

  const pick = async (event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    const element = describeTarget(event.target, { x: pageX, y: pageY });
    diag(`feedback picked ${element.nodeName ?? "?"} at ${Math.round(pageX)},${Math.round(pageY)}`);
    setPhase({ kind: "marking", element });
    await nextFrames();
    const shot = await captureScreen();
    setPhase({ kind: "writing", element, screenshot: shot ? uploadPhoto({ uri: shot.uri, width: shot.width, height: shot.height, fileName: "screen.jpg" }).catch(() => null) : Promise.resolve(null) });
  };

  const marked = phase.kind === "marking" || phase.kind === "writing" ? phase.element : null;
  return (
    <>
      <View style={styles.fill} onStartShouldSetResponderCapture={() => picking} onMoveShouldSetResponderCapture={() => picking}
        onResponderRelease={(event) => void pick(event)} onResponderTerminationRequest={() => false}>
        {children}
      </View>
      {marked && <Marker element={marked} />}
      {operator && phase.kind === "idle" && <FeedbackButton onPress={() => setPhase({ kind: "picking" })} />}
      {picking && <PickBanner onCancel={() => setPhase({ kind: "idle" })} />}
      {phase.kind === "writing" && (
        <FeedbackSheet element={phase.element} screenshot={phase.screenshot} route={pathname}
          onClose={() => setPhase({ kind: "idle" })} />
      )}
    </>
  );
}

function nextFrames() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function captureScreen(): Promise<Capture | null> {
  if (!screenCapture) return null;
  try {
    return await screenCapture.captureWindowAsync();
  } catch (error) {
    diag(`feedback capture failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function FeedbackButton({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Send feedback on this screen" onPress={onPress} hitSlop={8}
      style={({ pressed }) => [styles.tab, { top: Math.round(height * 0.42), backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
      <Icon name="rectangle.and.hand.point.up.left" size={20} color="textMuted" />
    </Pressable>
  );
}

function PickBanner({ onCancel }: { onCancel: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.banner, { top: insets.top + spacing.sm }]}>
      <View style={[styles.bannerBody, { backgroundColor: colors.textStrong }]}>
        <Text variant="bodyStrong" style={[styles.bannerText, { color: colors.background }]}>Tap what to change</Text>
        <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8} style={styles.bannerCancel}>
          <Text variant="bodyStrong" style={{ color: colors.background }}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Marker({ element }: { element: PhoneElement }) {
  const colors = useColors();
  const frame = element.frame;
  const hairline = 2 / PixelRatio.get() + 1;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {frame && frame.width > 0 && frame.height > 0 && (
        <View style={{ position: "absolute", left: frame.x - 2, top: frame.y - 2, width: frame.width + 4, height: frame.height + 4, borderWidth: hairline, borderColor: colors.textStrong, borderRadius: radius.sm, backgroundColor: withAlpha(colors.accent, 0.12) }} />
      )}
      <View style={[styles.ring, { left: element.tap.x - RING / 2, top: element.tap.y - RING / 2, borderColor: colors.textStrong }]} />
    </View>
  );
}

type FeedbackSheetProps = { element: PhoneElement; screenshot: Promise<ImageRef | null>; route: string; onClose: () => void };

function FeedbackSheet({ element, screenshot, route, onClose }: FeedbackSheetProps) {
  const colors = useColors();
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const router = useRouter();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  const send = async () => {
    if (sent.current || !text.trim()) return;
    sent.current = true;
    setSending(true);
    setError(null);
    try {
      const image = await screenshot;
      const request: PhoneFeedbackRequest = {
        text: text.trim(),
        route,
        screen: { width: Math.round(width), height: Math.round(height), scheme, fontScale, platform: `${Platform.OS} ${Platform.Version}`, appVersion: Constants.expoConfig?.version ?? null, updateId: Updates.isEmbeddedLaunch ? null : Updates.updateId ?? null },
        element,
        ...(image ? { images: [image] } : {}),
      };
      const agent = await store.sendFeedback(request);
      onClose();
      router.push({ pathname: "/session/[id]", params: { id: agent.id } });
    } catch (failure) {
      sent.current = false;
      setSending(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <Modal transparent visible animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable accessibilityLabel="Close feedback" style={styles.fill} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.separator, paddingBottom: insets.bottom + spacing.md }]}>
          <Text variant="bodyStrong" color="textStrong" numberOfLines={2}>Feedback on {elementTitle(element)}</Text>
          <TextInput autoFocus multiline value={text} onChangeText={setText} placeholder="What should change?" placeholderTextColor={colors.textMuted}
            style={[styles.input, { color: colors.textStrong, backgroundColor: colors.background, borderColor: colors.border }]} />
          {error && <Text variant="caption" color="danger">{error}</Text>}
          <View style={styles.actions}>
            <Button title="Cancel" kind="plain" onPress={onClose} />
            <Button title="Send" kind="primary" busy={sending} disabled={!text.trim()} onPress={() => void send()} />
          </View>
        </View>
        <KeyboardSpacer keyboardOnly />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tab: { position: "absolute", right: 0, width: 36, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderTopLeftRadius: radius.md, borderBottomLeftRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderRightWidth: 0, elevation: 2 },
  banner: { position: "absolute", left: spacing.lg, right: spacing.lg, alignItems: "center" },
  bannerBody: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: MIN_TOUCH, paddingLeft: spacing.lg, paddingRight: spacing.sm, borderRadius: radius.pill },
  bannerText: { flexShrink: 1 },
  bannerCancel: { minHeight: MIN_TOUCH, paddingHorizontal: spacing.sm, justifyContent: "center" },
  ring: { position: "absolute", width: RING, height: RING, borderRadius: RING / 2, borderWidth: 3 },
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  sheet: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderTopWidth: StyleSheet.hairlineWidth },
  input: { minHeight: 96, maxHeight: 200, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, textAlignVertical: "top" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});
