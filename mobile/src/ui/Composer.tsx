import * as Haptics from "expo-haptics";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { Agent, QueuedMessage } from "@shared/protocol";
import { MAX_IMAGES } from "../logic/images";
import { pickFromLibrary, takePhoto, useAttachments } from "../state/attach";
import { loadPref, savePref } from "../state/storage";
import { MIN_TOUCH, radius, spacing, useColors, withAlpha } from "../theme/theme";
import { showActionMenu } from "./actionMenu";
import { Icon } from "./Icon";
import { Text } from "./Text";

type Props = {
  agent: Agent | undefined;
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string, images: { id: string; label: string; thumb: string }[], steer: boolean) => Promise<void>;
  onStop?: () => void;
  onDequeue?: (queueId: string) => Promise<string | null>;
  onSendQueuedNow?: (queueId: string) => void;
  onCancelSteering?: (steeringId: string) => Promise<string | null>;
  autoFocus?: boolean;
  initialText?: string;
  draftKey?: string;
};

const MIN_HEIGHT = 44;
const MAX_HEIGHT = 144;

export const Composer = memo(function Composer({ agent, disabled, placeholder = "Message", onSend, onStop, onDequeue, onSendQueuedNow, onCancelSteering, autoFocus, initialText, draftKey }: Props) {
  const colors = useColors();
  const [text, setText] = useState(initialText ?? "");
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [steer, setSteer] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingSend, setPendingSend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useAttachments();
  const running = agent?.status === "running" || agent?.status === "waiting";
  const hasContent = text.trim().length > 0 || attachments.items.some((a) => a.status === "done");
  const textRef = useRef(text);
  textRef.current = text;
  const inFlight = useRef(false);
  const draftReady = useRef(!draftKey || !!initialText);

  useEffect(() => {
    void loadPref("steer", false).then(setSteer);
  }, []);
  useEffect(() => {
    if (initialText) setText(initialText);
  }, [initialText]);
  useEffect(() => {
    if (!draftKey || draftReady.current) return;
    let live = true;
    void loadPref<unknown>(`draft:${draftKey}`, "").then((saved) => {
      if (!live) return;
      if (typeof saved === "string" && saved) setText((current) => current || saved);
      draftReady.current = true;
    });
    return () => {
      live = false;
    };
  }, [draftKey]);
  useEffect(() => {
    if (!draftKey || !draftReady.current) return;
    const timer = setTimeout(() => savePref(`draft:${draftKey}`, text), 300);
    return () => clearTimeout(timer);
  }, [draftKey, text]);
  useEffect(
    () => () => {
      if (draftKey && draftReady.current && !inFlight.current) savePref(`draft:${draftKey}`, textRef.current);
    },
    [draftKey],
  );

  const submit = useCallback(async () => {
    if (inFlight.current) return;
    const images = attachments.refs();
    const prompt = text.trim();
    if (!prompt && images.length === 0) return;
    inFlight.current = true;
    const sentText = text;
    const sentKeys = attachments.items.map((a) => a.key);
    setSending(true);
    setError(null);
    try {
      await onSend(prompt, images, running && steer);
      const current = textRef.current;
      const rest = current.startsWith(sentText) ? current.slice(sentText.length).replace(/^\s+/, "") : current;
      textRef.current = rest;
      setText(rest);
      if (draftKey) savePref(`draft:${draftKey}`, rest);
      if (!rest) setHeight(MIN_HEIGHT);
      for (const key of sentKeys) attachments.remove(key);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      inFlight.current = false;
      setSending(false);
      setPendingSend(false);
    }
  }, [attachments, draftKey, onSend, running, steer, text]);

  useEffect(() => {
    if (pendingSend && attachments.ready && !sending) void submit();
  }, [pendingSend, attachments.ready, sending, submit]);

  const press = () => {
    if (!hasContent && !attachments.items.some((a) => a.status === "uploading" || a.status === "processing")) return;
    if (!attachments.ready) {
      setPendingSend(true);
      return;
    }
    void submit();
  };

  const attach = async () => {
    const room = MAX_IMAGES - attachments.items.filter((a) => a.status !== "error").length;
    if (room <= 0) return Alert.alert("Up to 5 images", "Remove one to attach another.");
    const choose = async (pick: () => Promise<{ uri: string; width: number; height: number; fileName?: string | null }[]>) => {
      try {
        attachments.addAssets(await pick());
      } catch (e) {
        Alert.alert("Could not attach", e instanceof Error ? e.message : String(e));
      }
    };
    showActionMenu("Attach an image", [
      { label: "Photo Library", onPress: () => void choose(() => pickFromLibrary(room)) },
      { label: "Take Photo", onPress: () => void choose(takePhoto) },
    ]);
  };

  const setMode = (next: boolean) => {
    setSteer(next);
    savePref("steer", next);
  };

  const queue = agent?.queue ?? [];
  const steering = agent?.steering ?? [];
  const busyUpload = attachments.progress !== null;
  const sendDisabled = disabled || sending || (!hasContent && !busyUpload);

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background, borderTopColor: colors.separator }]}>
      {(queue.length > 0 || steering.length > 0) && (
        <View style={styles.queue}>
          {steering.map((m) => (
            <QueueChip key={m.id} message={m} label="Steering" onCancel={onCancelSteering ? async () => { const back = await onCancelSteering(m.id); if (back) setText((t) => (t ? `${t}\n${back}` : back)); } : undefined} />
          ))}
          {queue.map((m) => (
            <QueueChip key={m.id} message={m} label="Queued" onNow={onSendQueuedNow ? () => onSendQueuedNow(m.id) : undefined} onCancel={onDequeue ? async () => { const back = await onDequeue(m.id); if (back) setText((t) => (t ? `${t}\n${back}` : back)); } : undefined} />
          ))}
        </View>
      )}
      {running && (
        <View style={styles.modeRow}>
          <View style={[styles.segment, { backgroundColor: colors.surfaceBase, borderColor: colors.separator }]}>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: !steer }} onPress={() => setMode(false)} style={[styles.segmentItem, !steer && { backgroundColor: colors.selected }]}>
              <Text variant="secondary" color={!steer ? "textStrong" : "textMuted"}>Queue</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: steer }} onPress={() => setMode(true)} style={[styles.segmentItem, steer && { backgroundColor: colors.selected }]}>
              <Text variant="secondary" color={steer ? "textStrong" : "textMuted"}>Steer</Text>
            </Pressable>
          </View>
          <View style={{ flex: 1 }} />
          {onStop && (
            <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={onStop} style={[styles.stop, { backgroundColor: withAlpha(colors.danger, 0.16) }]}>
              <Icon name="stop.fill" size={14} color="danger" />
              <Text variant="secondary" color="danger" style={{ fontWeight: "600" }}>Stop</Text>
            </Pressable>
          )}
        </View>
      )}
      {attachments.items.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow} keyboardShouldPersistTaps="handled">
          {attachments.items.map((a) => (
            <View key={a.key} style={styles.thumbWrap}>
              <Image source={{ uri: a.uri }} style={[styles.thumb, { backgroundColor: colors.surfaceBase, opacity: a.status === "done" ? 1 : 0.55 }]} accessibilityLabel={a.name} />
              {(a.status === "processing" || a.status === "uploading") && (
                <View style={styles.thumbOverlay} pointerEvents="none">
                  <ActivityIndicator color={colors.textStrong} />
                  {a.status === "uploading" && <Text variant="caption" color="textStrong">{`${Math.round(a.progress * 100)}%`}</Text>}
                </View>
              )}
              {a.status === "error" && (
                <Pressable style={[styles.thumbOverlay, { backgroundColor: withAlpha(colors.danger, 0.55) }]} onPress={() => Alert.alert("Upload failed", a.error ?? "Unknown error")}>
                  <Icon name="exclamationmark" size={22} color="onAccent" weight="bold" />
                </Pressable>
              )}
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`} hitSlop={10} onPress={() => attachments.remove(a.key)} style={[styles.thumbRemove, { backgroundColor: colors.overlay, borderColor: colors.border }]}>
                <Icon name="xmark" size={10} color="textStrong" weight="bold" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Attach image" onPress={attach} disabled={disabled} style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}>
          <Icon name="plus.circle.fill" size={30} color="textMuted" />
        </Pressable>
        <TextInput
          autoFocus={autoFocus}
          value={text}
          onChangeText={setText}
          onContentSizeChange={(e) => setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height) + 16)))}
          placeholder={placeholder}
          placeholderTextColor={colors.textSubtle}
          multiline
          editable={!disabled}
          maxFontSizeMultiplier={1.6}
          accessibilityLabel="Message"
          style={[styles.input, { height, color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}
        />
        <Pressable accessibilityRole="button" accessibilityLabel={running && steer ? "Steer" : running ? "Queue message" : "Send"} accessibilityState={{ disabled: sendDisabled }} onPress={press} disabled={sendDisabled} style={({ pressed }) => [styles.send, { backgroundColor: sendDisabled ? colors.overlay : colors.accent, opacity: pressed ? 0.8 : 1 }]}>
          {sending || pendingSend ? <ActivityIndicator color={colors.onAccent} /> : <Icon name="arrow.up" size={20} color={sendDisabled ? "textSubtle" : "onAccent"} weight="bold" />}
        </Pressable>
      </View>
      {pendingSend && <Text variant="caption" color="textMuted" style={styles.note}>{`Sending when the upload finishes${attachments.progress !== null ? ` (${Math.round(attachments.progress * 100)}%)` : ""}`}</Text>}
      {error && <Text variant="caption" color="danger" style={styles.note}>{error}</Text>}
    </View>
  );
});

function QueueChip({ message, label, onCancel, onNow }: { message: QueuedMessage; label: string; onCancel?: () => void; onNow?: () => void }) {
  const colors = useColors();
  const shown = (message.shown ?? message.text).replace(/\s+/g, " ").trim() || "Image";
  return (
    <View style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
      <Text variant="caption" color="accentText">{label}</Text>
      <Text variant="secondary" numberOfLines={1} style={{ flex: 1 }}>{shown}</Text>
      {onNow && (
        <Pressable accessibilityRole="button" accessibilityLabel="Send now" hitSlop={8} onPress={onNow} style={styles.chipButton}>
          <Icon name="arrow.up.circle" size={22} color="accentText" />
        </Pressable>
      )}
      {onCancel && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${label.toLowerCase()} message`} hitSlop={8} onPress={onCancel} style={styles.chipButton}>
          <Icon name="xmark.circle.fill" size={22} color="textSubtle" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  input: { flex: 1, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg, paddingTop: 10, paddingBottom: 10, fontSize: 16, lineHeight: 22, textAlignVertical: "center" },
  iconButton: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  send: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: "center", justifyContent: "center" },
  modeRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  segment: { flexDirection: "row", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 2 },
  segmentItem: { minHeight: 36, minWidth: 72, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, paddingHorizontal: spacing.md },
  stop: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.md, borderRadius: radius.md },
  queue: { gap: spacing.xs },
  chip: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 40, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingLeft: spacing.md, paddingRight: spacing.xs },
  chipButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  thumbRow: { gap: spacing.sm, paddingTop: spacing.xs, paddingRight: spacing.sm },
  thumbWrap: { width: 64, height: 64 },
  thumb: { width: 64, height: 64, borderRadius: radius.sm },
  thumbOverlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  thumbRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  note: { paddingHorizontal: spacing.sm },
});
