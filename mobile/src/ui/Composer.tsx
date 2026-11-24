import { useIsFocused } from "expo-router";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, TextInput, View, findNodeHandle } from "react-native";
import type { MobileFileRef } from "@shared/mobile";
import type { Agent, EffortLevel, Harness, QueuedMessage } from "@shared/protocol";
import { MAX_FILES, MAX_IMAGES, isFileAttachment } from "../logic/images";
import { pickFiles, pickFromLibrary, useAttachments } from "../state/attach";
import { composerPaste, discardPastedImage, isPasteForeground, legacyPasteSupported, nextPasteBinding, readClipboardImage } from "../state/composerPaste";
import { useAppState } from "../state/app";
import { loadPref, savePref } from "../state/storage";
import { MIN_TOUCH, radius, spacing, useColors, withAlpha } from "../theme/theme";
import { showActionMenu } from "./actionMenu";
import { useWindowFontScale } from "./FoldLayout";
import { Icon } from "./Icon";
import { ModelSubtitle, modelPickerLabel } from "./ModelPicker";
import { ProviderMark, PROVIDER_NAMES } from "./ProviderMark";
import { Text } from "./Text";

type Props = {
  agent: Agent | undefined;
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string, images: { id: string; label: string; thumb: string }[], steer: boolean, files: MobileFileRef[]) => Promise<void>;
  onStop?: () => void;
  onDequeue?: (queueId: string) => Promise<string | null>;
  onSendQueuedNow?: (queueId: string) => void;
  onCancelSteering?: (steeringId: string) => Promise<string | null>;
  autoFocus?: boolean;
  initialText?: string;
  draftKey?: string;
  modelControl?: { harness: Harness; name: string; effort: EffortLevel | null; onPress: () => void; disabled?: boolean };
};

const MIN_HEIGHT = MIN_TOUCH;
const INPUT_LINE_HEIGHT = 22;
const INPUT_FONT_LIMIT = 1.6;
const INPUT_PADDING = spacing.xs;
const MAX_INPUT_LINES = 4;

export const Composer = memo(function Composer({ agent, disabled, placeholder = "Message", onSend, onStop, onDequeue, onSendQueuedNow, onCancelSteering, autoFocus, initialText, draftKey, modelControl }: Props) {
  const colors = useColors();
  const fontScale = Math.min(useWindowFontScale(), INPUT_FONT_LIMIT);
  const [text, setText] = useState(initialText ?? "");
  const [height, setHeight] = useState(MIN_HEIGHT);
  const maxInputHeight = Math.ceil(INPUT_LINE_HEIGHT * fontScale * MAX_INPUT_LINES) + INPUT_PADDING * 2;
  const editorHeight = Math.min(Math.max(MIN_HEIGHT, maxInputHeight), height);
  const [wraps, setWraps] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState(() => ({ start: initialText?.length ?? 0, end: initialText?.length ?? 0 }));
  const [nextSelection, setNextSelection] = useState<typeof selection>();
  const [queueExpanded, setQueueExpanded] = useState(false);
  const steerByDefault = useAppState((s) => s.requestQueuing === "steer");
  const [flipMode, setFlipMode] = useState(false);
  const steer = steerByDefault !== flipMode;
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
  const { addAssets, addFiles } = attachments;
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
    const files = attachments.fileRefs();
    const prompt = text.trim();
    if (!prompt && images.length === 0 && files.length === 0) return;
    inFlight.current = true;
    const sentText = text;
    const sentAttachments = attachments.items.filter((a) => a.status === "done");
    for (const a of attachments.items) attachments.remove(a.key);
    textRef.current = "";
    setText("");
    setHeight(MIN_HEIGHT);
    if (draftKey) savePref(`draft:${draftKey}`, "");
    setSending(true);
    setError(null);
    try {
      await onSend(prompt, images, running && steer, files);
      setFlipMode(false);
    } catch (e) {
      const current = textRef.current;
      const restored = current.trim() ? `${sentText.trimEnd()}\n${current}` : sentText;
      textRef.current = restored;
      setText(restored);
      if (draftKey) savePref(`draft:${draftKey}`, restored);
      attachments.restore(sentAttachments);
      setError(e instanceof Error ? e.message : String(e));
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
    if (modelControl && !modelControl.disabled && text.trim().toLowerCase() === "/model") {
      const start = text.toLowerCase().indexOf("/model");
      openModelCommand(start, start + "/model".length);
      return;
    }
    if (!pasteBatches.current && !hasContent && !attachments.items.some((a) => a.status === "uploading" || a.status === "processing")) return;
    if (pasteBatches.current > 0 || !attachments.ready) {
      setPendingSend(true);
      return;
    }
    void submit();
  };

  const attach = () => {
    const scope = pasteScope.current;
    const live = attachments.items.filter((a) => a.status !== "error");
    const imageRoom = MAX_IMAGES - live.filter((a) => !isFileAttachment(a)).length;
    const fileRoom = MAX_FILES - live.filter(isFileAttachment).length;
    const run = async <T,>(pick: () => Promise<T[]>, add: (picked: T[]) => number, fromClipboard = false) => {
      if (!scope || pasteScope.current !== scope) return;
      try {
        const picked = await pick();
        if (pasteScope.current === scope && (!fromClipboard || isPasteForeground())) add(picked);
      } catch (e) {
        if (pasteScope.current !== scope) return;
        if (fromClipboard) setPendingSend(false);
        Alert.alert("Could not attach", e instanceof Error ? e.message : String(e));
      }
    };
    const withImageRoom = (pick: () => void) => () => (imageRoom <= 0 ? Alert.alert("Up to 5 images", "Remove one to attach another.") : pick());
    showActionMenu("Attach", [
      { label: "Photo Library", onPress: withImageRoom(() => void run(() => pickFromLibrary(imageRoom), addAssets)) },
      { label: "Choose File", onPress: () => (fileRoom <= 0 ? Alert.alert(`Up to ${MAX_FILES} files`, "Remove one to attach another.") : void run(pickFiles, addFiles)) },
      ...(legacyPasteSupported ? [{
        label: "Paste image",
        onPress: withImageRoom(() => {
          if (!scope || pasteScope.current !== scope || !isPasteForeground()) return;
          pasteBatches.current++;
          setPasting(true);
          void run(readClipboardImage, addAssets, true).finally(() => {
            if (pasteScope.current !== scope) return;
            pasteBatches.current--;
            setPasting(pasteBatches.current > 0);
          });
        }),
      }] : []),
    ]);
  };

  const setMode = (next: boolean) => setFlipMode(next !== steerByDefault);

  const queue = agent?.queue ?? [];
  const steering = agent?.steering ?? [];
  const busyUpload = pasting || attachments.progress !== null;
  const hasDraft = hasContent || busyUpload;
  const pendingCount = queue.length + steering.length;
  const showQueue = pendingCount < 3 || queueExpanded;
  const sendDisabled = !canSend || sending || (!hasContent && !busyUpload);
  const modelAvailable = !!modelControl && !modelControl.disabled && !disabled;
  const showStop = !!(running && onStop);
  const showSend = !showStop || hasDraft || pendingSend;
  const compactStart = MIN_TOUCH + spacing.xs;
  const modelWidth = modelControl ? MIN_TOUCH : 0;
  const compactEnd = modelWidth + MIN_TOUCH * (Number(showStop) + Number(showSend)) + spacing.xs;
  const expanded = !!text.length && (wraps || text.includes("\n"));
  const token = editing && modelAvailable && selection.start === selection.end ? text.slice(0, selection.start).match(/(?:^|\s)(\/[a-z]*)$/i)?.[1] : undefined;
  const modelCommand = token && "/model".startsWith(token.toLowerCase()) && !/\w/.test(text[selection.end] ?? "") ? token : undefined;

  const openModelCommand = (start: number, end: number) => {
    if (!modelControl) return;
    const cursor = { start, end: start };
    setNextSelection(cursor);
    setSelection(cursor);
    setText(text.slice(0, start) + text.slice(end));
    modelControl.onPress();
  };

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
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
              {isFileAttachment(a) ? (
                <View accessibilityLabel={a.name} style={[styles.thumb, styles.fileTile, { backgroundColor: colors.surfaceBase, borderColor: colors.border, opacity: a.status === "done" ? 1 : 0.55 }]}>
                  <Icon name="doc" size={20} color="textMuted" />
                  <Text variant="caption" color="textStrong" numberOfLines={1} ellipsizeMode="middle" style={styles.fileName}>{a.name}</Text>
                </View>
              ) : (
                <Image source={{ uri: a.uri }} style={[styles.thumb, { backgroundColor: colors.surfaceBase, opacity: a.status === "done" ? 1 : 0.55 }]} accessibilityLabel={a.name} />
              )}
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
      {modelCommand && <Pressable accessibilityRole="button" accessibilityLabel="/model, Switch model" onPress={() => openModelCommand(selection.start - modelCommand.length, selection.end)}
        style={({ pressed }) => [styles.command, { backgroundColor: pressed ? colors.pressed : colors.surface, borderColor: colors.separator }]}>
        <Text variant="secondary" color="textStrong">/model</Text>
        <Text variant="caption" color="textMuted" numberOfLines={1}>Switch model</Text>
      </Pressable>}
      <View style={[styles.surface, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}>
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.measure, { start: compactStart, end: compactEnd }]}>
          <Text variant="body" maxFontSizeMultiplier={INPUT_FONT_LIMIT} style={styles.inputType} onTextLayout={(event) => setWraps(event.nativeEvent.lines.length > 1)}>{text}</Text>
        </View>
        <View style={[styles.row, expanded && { paddingTop: editorHeight }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Attach" onPress={attach} disabled={disabled} style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}>
            <Icon name="plus" size={22} color="textMuted" />
          </Pressable>
          <TextInput
            ref={input}
            onLayout={bindPaste}
            onFocus={() => { setEditing(true); bindPaste(); }}
            onBlur={() => setEditing(false)}
            autoFocus={autoFocus}
            value={text}
            onChangeText={setText}
            selection={nextSelection}
            onSelectionChange={({ nativeEvent }) => {
              setSelection(nativeEvent.selection);
              if (nextSelection?.start === nativeEvent.selection.start && nextSelection.end === nativeEvent.selection.end) setNextSelection(undefined);
            }}
            onContentSizeChange={(e) => setHeight(Math.max(MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height)))}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            multiline
            disableFullscreenUI
            editable={!disabled}
            maxFontSizeMultiplier={INPUT_FONT_LIMIT}
            accessibilityLabel="Message"
            style={[styles.input, styles.inputType, { color: colors.textStrong, start: expanded ? spacing.md : compactStart, end: expanded ? spacing.md : compactEnd, height: expanded ? editorHeight : MIN_HEIGHT, bottom: expanded ? MIN_TOUCH : 0 }]}
          />
          <View style={styles.controls}>
            {modelControl && <Pressable accessibilityRole="button" accessibilityLabel={`${PROVIDER_NAMES[modelControl.harness]}, ${modelPickerLabel(modelControl.name, modelControl.effort)}`}
              accessibilityState={{ disabled: !modelAvailable }} disabled={!modelAvailable} onPress={modelControl.onPress}
              style={({ pressed }) => [styles.model, expanded ? styles.modelExpanded : { width: modelWidth }, pressed && { backgroundColor: colors.pressed }]}>
              <ProviderMark harness={modelControl.harness} size={18} selected />
              {expanded ? <ModelSubtitle name={modelControl.name} effort={modelControl.effort} /> : <Icon name="chevron.down" size={12} color="textMuted" />}
            </Pressable>}
            {showStop && <Pressable accessibilityRole="button" accessibilityLabel="Stop" disabled={!canSend} onPress={onStop} style={styles.iconButton}>
              {({ pressed }) => <View style={[styles.send, { backgroundColor: colors.textStrong, opacity: pressed ? 0.8 : 1 }]}><View style={[styles.stopMark, { backgroundColor: colors.background }]} /></View>}
            </Pressable>}
            {showSend && <Pressable accessibilityRole="button" accessibilityLabel={running && steer ? "Steer" : running ? "Queue message" : "Send"} accessibilityState={{ disabled: sendDisabled }} onPress={press} disabled={sendDisabled} style={styles.iconButton}>
              {({ pressed }) => <View style={[styles.send, { backgroundColor: sendDisabled ? colors.overlay : colors.accent, opacity: pressed ? 0.8 : 1 }]}>
                {sending || pendingSend ? <ActivityIndicator color={colors.onAccent} /> : <Icon name="arrow.up" size={18} color={sendDisabled ? "textSubtle" : "onAccent"} weight="bold" />}
              </View>}
            </Pressable>}
          </View>
        </View>
      </View>
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
  wrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: spacing.xs },
  surface: { borderRadius: 24, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", minHeight: MIN_TOUCH },
  measure: { position: "absolute", opacity: 0 },
  input: { position: "absolute", paddingHorizontal: 0, paddingVertical: INPUT_PADDING, textAlignVertical: "center" },
  inputType: { fontSize: 16, lineHeight: INPUT_LINE_HEIGHT, includeFontPadding: false },
  iconButton: { width: MIN_TOUCH, height: MIN_TOUCH, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  controls: { marginStart: "auto", flexDirection: "row", alignItems: "center", flexShrink: 1, minWidth: 0 },
  model: { minWidth: MIN_TOUCH, height: MIN_TOUCH, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, borderRadius: radius.md },
  modelExpanded: { flexShrink: 1, maxWidth: 190, paddingHorizontal: spacing.sm },
  command: { minHeight: MIN_TOUCH, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: spacing.md },
  send: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  stopMark: { width: 11, height: 11, borderRadius: 2 },
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
  fileTile: { borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: spacing.xs },
  fileName: { textAlign: "center", alignSelf: "stretch" },
  thumbOverlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  thumbRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  note: { paddingHorizontal: spacing.sm },
});
