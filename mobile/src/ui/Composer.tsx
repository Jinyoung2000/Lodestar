import * as Haptics from "expo-haptics";
import { useIsFocused } from "expo-router";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, TextInput, View, findNodeHandle } from "react-native";
import type { Agent, QueuedMessage } from "@shared/protocol";
import { MAX_IMAGES } from "../logic/images";
import { pickFromLibrary, takePhoto, useAttachments, type PickedAsset } from "../state/attach";
import { composerPaste, discardPastedImage, isPasteForeground, legacyPasteSupported, nextPasteBinding, readClipboardImage } from "../state/composerPaste";
import { loadPref, savePref } from "../state/storage";
import { radius, spacing, useColors, withAlpha } from "../theme/theme";
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
  promptOptions?: ReactNode;
};

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 144;

export const Composer = memo(function Composer({ agent, disabled, placeholder = "Message", onSend, onStop, onDequeue, onSendQueuedNow, onCancelSteering, autoFocus, initialText, draftKey, promptOptions }: Props) {
  const colors = useColors();
  const [text, setText] = useState(initialText ?? "");
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [steer, setSteer] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingSend, setPendingSend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useAttachments();
  const focused = useIsFocused();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const pasteScope = useRef<string | null>(null);
  const pasteBatches = useRef(0);
  const [pasting, setPasting] = useState(false);
  const canSend = focused && !disabled;
  const { addAssets } = attachments;
  const bindPaste = useCallback(() => {
    const token = pasteScope.current;
    const tag = findNodeHandle(input.current);
    if (token && tag != null) void composerPaste?.bind(tag, token).catch((error) => console.warn("Could not bind clipboard image paste", error));
  }, []);

  useLayoutEffect(() => {
    if (!canSend) return;
    const token = nextPasteBinding();
    pasteScope.current = token;
    const native = composerPaste;
    const started = native?.addListener("pasteStarted", (event) => {
      if (event.token !== token || pasteScope.current !== token) return;
      pasteBatches.current++;
      setPasting(true);
    });
    const finished = native?.addListener("pasteFinished", (event) => {
      if (event.token !== token) return;
      const assets = event.assets ?? [];
      if (pasteScope.current !== token || !isPasteForeground()) {
        assets.forEach((asset) => discardPastedImage(asset.uri));
        setPendingSend(false);
      } else if (event.full) {
        setError("You can attach up to 5 images.");
      } else {
        const accepted = addAssets(assets.map((asset) => ({ ...asset, releaseSource: () => discardPastedImage(asset.uri) })));
        if (event.failed) {
          setPendingSend(false);
          setError("Could not read the clipboard image. It may be too large or unavailable.");
        } else if (accepted < assets.length) {
          setError("You can attach up to 5 images.");
        } else {
          setError(null);
        }
      }
      if (!event.full) {
        pasteBatches.current = Math.max(0, pasteBatches.current - 1);
        setPasting(pasteBatches.current > 0);
      }
    });
    bindPaste();
    return () => {
      pasteScope.current = null;
      pasteBatches.current = 0;
      setPasting(false);
      started?.remove();
      finished?.remove();
      void native?.unbind(token).catch((error) => console.warn("Could not unbind clipboard image paste", error));
    };
  }, [addAssets, bindPaste, canSend, draftKey]);

  const running = agent?.status === "running";
  const hasContent = text.trim().length > 0 || attachments.items.some((a) => a.status === "done");
  const textRef = useRef(text);
  textRef.current = text;
  const inFlight = useRef(false);
  const draftReady = useRef(!draftKey || !!initialText);

  useEffect(() => {
    let active = true;
    void loadPref("steer", false).then((value) => { if (active) setSteer(value); });
    return () => { active = false; };
  }, []);
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
    if (inFlight.current || !canSend || pasteBatches.current > 0) return;
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
  }, [attachments, canSend, draftKey, onSend, running, steer, text]);

  useEffect(() => {
    if (!pendingSend) return;
    if (!canSend || attachments.items.some((asset) => asset.status === "error")) {
      setPendingSend(false);
    } else if (!pasting && attachments.ready && !sending) {
      void submit();
    }
  }, [pendingSend, attachments, canSend, pasting, sending, submit]);

  const press = () => {
    if (!canSend) return;
    if (!pasteBatches.current && !hasContent && !attachments.items.some((a) => a.status === "uploading" || a.status === "processing")) return;
    if (pasteBatches.current > 0 || !attachments.ready) {
      setPendingSend(true);
      return;
    }
    void submit();
  };

  const attach = () => {
    const scope = pasteScope.current;
    const room = MAX_IMAGES - attachments.items.filter((a) => a.status !== "error").length;
    if (room <= 0) return Alert.alert("Up to 5 images", "Remove one to attach another.");
    const choose = async (pick: () => Promise<PickedAsset[]>) => {
      if (!scope || pasteScope.current !== scope) return;
      try {
        const assets = await pick();
        if (pasteScope.current === scope && (pick !== readClipboardImage || isPasteForeground())) addAssets(assets);
      } catch (e) {
        if (pasteScope.current !== scope) return;
        if (pick === readClipboardImage) setPendingSend(false);
        Alert.alert("Could not attach", e instanceof Error ? e.message : String(e));
      }
    };
    showActionMenu("Attach an image", [
      { label: "Photo Library", onPress: () => void choose(() => pickFromLibrary(room)) },
      { label: "Take Photo", onPress: () => void choose(takePhoto) },
      ...(legacyPasteSupported ? [{
        label: "Paste image",
        onPress: () => {
          if (!scope || pasteScope.current !== scope || !isPasteForeground()) return;
          pasteBatches.current++;
          setPasting(true);
          void choose(readClipboardImage).finally(() => {
            if (pasteScope.current !== scope) return;
            pasteBatches.current--;
            setPasting(pasteBatches.current > 0);
          });
        },
      }] : []),
    ]);
  };

  const setMode = (next: boolean) => {
    setSteer(next);
    savePref("steer", next);
  };

  const queue = agent?.queue ?? [];
  const steering = agent?.steering ?? [];
  const busyUpload = pasting || attachments.progress !== null;
  const hasDraft = hasContent || busyUpload;
  const pendingCount = queue.length + steering.length;
  const showQueue = pendingCount < 3 || queueExpanded;
  const sendDisabled = !canSend || sending || (!hasContent && !busyUpload);

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background, borderTopColor: colors.separator }]}>
      {pendingCount >= 3 && <Pressable accessibilityRole="button" accessibilityState={{ expanded: queueExpanded }} onPress={() => setQueueExpanded((expanded) => !expanded)} style={styles.queueToggle}>
        <Text variant="caption" color="accentText">{`${pendingCount} queued`}</Text>
        <Icon name={queueExpanded ? "chevron.up" : "chevron.down"} size={12} color="textMuted" />
      </Pressable>}
      {pendingCount > 0 && showQueue && (
        <View style={styles.queue}>
          {steering.map((m) => (
            <QueueChip key={m.id} message={m} label="Steering" onCancel={onCancelSteering ? async () => { const back = await onCancelSteering(m.id); if (back) setText((t) => (t ? `${t}\n${back}` : back)); } : undefined} />
          ))}
          {queue.map((m) => (
            <QueueChip key={m.id} message={m} label="Queued" onNow={onSendQueuedNow ? () => onSendQueuedNow(m.id) : undefined} onCancel={onDequeue ? async () => { const back = await onDequeue(m.id); if (back) setText((t) => (t ? `${t}\n${back}` : back)); } : undefined} />
          ))}
        </View>
      )}
      {running && hasDraft && (
        <View style={styles.modeRow}>
          <View style={[styles.segment, { backgroundColor: colors.surfaceBase, borderColor: colors.separator }]}>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: !steer }} hitSlop={{ top: 6, bottom: 2 }} onPress={() => setMode(false)} style={[styles.segmentItem, !steer && { backgroundColor: colors.selected }]}>
              <Text variant="secondary" style={styles.modeLabel} color={!steer ? "textStrong" : "textMuted"}>Queue</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: steer }} hitSlop={{ top: 6, bottom: 2 }} onPress={() => setMode(true)} style={[styles.segmentItem, steer && { backgroundColor: colors.selected }]}>
              <Text variant="secondary" style={styles.modeLabel} color={steer ? "textStrong" : "textMuted"}>Steer</Text>
            </Pressable>
          </View>
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
        <Pressable accessibilityRole="button" accessibilityLabel="Attach image" hitSlop={4} onPress={attach} disabled={disabled} style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}>
          <Icon name="plus.circle.fill" size={22} color="textMuted" />
        </Pressable>
        <TextInput
          ref={input}
          onLayout={bindPaste}
          onFocus={bindPaste}
          autoFocus={autoFocus}
          value={text}
          onChangeText={setText}
          onContentSizeChange={(e) => setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height))))}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          multiline
          disableFullscreenUI
          editable={!disabled}
          maxFontSizeMultiplier={1.6}
          accessibilityLabel="Message"
          style={[styles.input, { height, color: colors.textStrong, backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}
        />
        {running && onStop && <Pressable accessibilityRole="button" accessibilityLabel="Stop" hitSlop={4} disabled={!canSend} onPress={onStop} style={styles.iconButton}>
          <View style={[styles.send, { backgroundColor: withAlpha(colors.danger, 0.16) }]}><Icon name="stop.fill" size={12} color="danger" /></View>
        </Pressable>}
        {(!running || !onStop || hasDraft || pendingSend) && <Pressable accessibilityRole="button" hitSlop={4} accessibilityLabel={running && steer ? "Steer" : running ? "Queue message" : "Send"} accessibilityState={{ disabled: sendDisabled }} onPress={press} disabled={sendDisabled} style={styles.iconButton}>
          {({ pressed }) => <View style={[styles.send, { backgroundColor: sendDisabled ? colors.overlay : colors.accent, opacity: pressed ? 0.8 : 1 }]}>
            {sending || pendingSend ? <ActivityIndicator color={colors.onAccent} /> : <Icon name="arrow.up" size={18} color={sendDisabled ? "textSubtle" : "onAccent"} weight="bold" />}
          </View>}
        </Pressable>}
      </View>
      {promptOptions}
      {pasting && !pendingSend && <Text variant="caption" color="textMuted" style={styles.note}>Reading clipboard image…</Text>}
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
          <Icon name="arrow.up.circle" size={18} color="accentText" />
        </Pressable>
      )}
      {onCancel && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${label.toLowerCase()} message`} hitSlop={8} onPress={onCancel} style={styles.chipButton}>
          <Icon name="xmark.circle.fill" size={18} color="textSubtle" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  input: { flex: 1, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingTop: 8, paddingBottom: 8, fontSize: 16, lineHeight: 22, textAlignVertical: "center" },
  iconButton: { width: MIN_HEIGHT, height: MIN_HEIGHT, alignItems: "center", justifyContent: "center" },
  send: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  modeRow: { alignItems: "flex-end" },
  segment: { flexDirection: "row", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 2 },
  segmentItem: { minHeight: 24, minWidth: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, paddingHorizontal: spacing.md },
  modeLabel: { fontSize: 13, lineHeight: 18 },
  queueToggle: { flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 32 },
  queue: { gap: spacing.xs },
  chip: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 32, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingLeft: spacing.md, paddingRight: spacing.xs },
  chipButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  thumbRow: { gap: spacing.sm, paddingTop: spacing.xs, paddingRight: spacing.sm },
  thumbWrap: { width: 64, height: 64 },
  thumb: { width: 64, height: 64, borderRadius: radius.sm },
  thumbOverlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  thumbRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  note: { paddingHorizontal: spacing.sm },
});
