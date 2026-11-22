import { useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useEffect, useCallback, useMemo, useRef, useState, type ComponentProps, type ReactElement } from "react";
import { ActivityIndicator, Alert, BackHandler, FlatList, Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import type { MobilePreview } from "@shared/mobile";
import { formatLabel, type Preview, type PreviewKind } from "../logic/previews";
import { escapeHtml, spreadsheet, thumbnailDocument, vectorDocument } from "../logic/previewDocuments";
import { expandPreview, releasePreview, useExpandedPreview } from "../state/expandedPreview";
import { relativeTime } from "../logic/time";
import { client } from "../state/app";
import { radius, spacing, useColors } from "../theme/theme";
import { palette } from "../theme/tokens.generated";
import { Icon } from "./Icon";
import { MarkdownView } from "./MarkdownView";
import { Text } from "./Text";
import { Button } from "./Button";
import { useFoldLayout } from "./FoldLayout";
import { useKeyboardTop } from "./KeyboardSpacer";

import { cachedThumbnail, PreviewThumbnail } from "./PreviewThumbnail";

function renderDocument(content: MobilePreview, title: string, width: number, height: number) {
  return <PreviewContent content={content} title={title} tile={{ width, height }} />;
}

export function PreviewRow({ file, open, agentId, grouped }: { file: Preview; open: (file: Preview) => void; agentId?: string; grouped?: boolean }) {
  const colors = useColors();
  return (
    <Pressable onPress={() => open(file)} accessibilityRole="button" accessibilityLabel={`Open ${file.title}, ${formatLabel[file.kind]}`}
      style={({ pressed }) => [!grouped && styles.card, styles.row, { borderColor: colors.separator, backgroundColor: pressed ? colors.pressed : colors.surface }]}>
      <View style={[styles.thumb, { borderColor: colors.separator }]}><PreviewThumbnail file={file} agentId={agentId} renderDocument={renderDocument} /></View>
      <View style={styles.title}>
        <Text variant="bodyStrong" color="textStrong" numberOfLines={2} style={styles.rowTitle}>{file.title}</Text>
        <Text variant="caption" color="textMuted">{formatLabel[file.kind]}</Text>
      </View>
      <Icon name="chevron.right" color="textSubtle" size={18} />
    </Pressable>
  );
}

type ViewableRows = { viewableItems: { index?: number | null }[] };

function useVisibleRows() {
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
  const onViewableItemsChanged = useCallback(({ viewableItems }: ViewableRows) => {
    setVisible(new Set(viewableItems.flatMap(({ index }) => index == null ? [] : [index])));
  }, []);
  return { visible, onViewableItemsChanged };
}

const filters: { label: string; kinds?: PreviewKind[] }[] = [
  { label: "All" }, { label: "HTML", kinds: ["html"] }, { label: "Images", kinds: ["image", "svg"] },
  { label: "Documents", kinds: ["markdown"] }, { label: "Tables", kinds: ["csv"] },
];

export function PreviewGallery({ files, open, onCreate, canCreate, footer, agentId }: {
  files: readonly Preview[];
  open: (file: Preview) => void;
  onCreate: () => void;
  canCreate: boolean;
  footer?: ReactElement;
  agentId: string;
}) {
  const colors = useColors();
  const window = useWindowDimensions();
  const { paneWidth, fontScale } = useFoldLayout();
  const width = paneWidth || window.width;
  const [filter, setFilter] = useState(0);
  const showFilters = files.length >= 6 || new Set(files.map(({ kind }) => kind)).size > 2;
  const activeFilter = showFilters ? filter : 0;
  const matching = useMemo(() => {
    const kinds = filters[activeFilter].kinds;
    return kinds ? files.filter(({ kind }) => kinds.includes(kind)) : files;
  }, [files, activeFilter]);
  const columns = width < 340 || fontScale >= 1.3 || matching.length === 1 ? 1 : width >= 600 ? 3 : 2;
  const { visible: visibleRows, onViewableItemsChanged } = useVisibleRows();
  const pairs = useMemo(() => {
    const rows: Preview[][] = [];
    for (let index = 0; index < matching.length; index += columns) rows.push(matching.slice(index, index + columns));
    return rows;
  }, [matching, columns]);
  const create = <Button title="New preview" kind="plain" disabled={!canCreate} onPress={onCreate} />;
  return <FlatList
    style={styles.fill}
    contentContainerStyle={styles.gallery}
    data={pairs}
    ListHeaderComponent={<>
      <View style={styles.galleryHead}>
        <Text variant="secondary" color="textStrong" style={styles.weight}>{matching.length} {matching.length === 1 ? "preview" : "previews"}</Text>
        {files.length > 0 && create}
      </View>
      {showFilters && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipContent}>
        {filters.map(({ label }, index) => {
          const selected = index === activeFilter;
          return <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => setFilter(index)}
            style={[styles.chip, selected ? { backgroundColor: colors.selected } : { borderWidth: 1, borderColor: colors.border }]}>
            <Text variant="secondary" color={selected ? "textStrong" : "textMuted"} style={styles.chipLabel}>{label}</Text>
          </Pressable>;
        })}
      </ScrollView>}
    </>}
    ListEmptyComponent={<View style={styles.emptyGallery}>
      <Text variant="title" color="textStrong">{files.length ? "No matching previews" : "No previews yet"}</Text>
      {!files.length && <>
        <Text variant="secondary" color="textMuted" style={styles.centerText}>Create a prototype, diagram, document or table for this session.</Text>
        {create}
      </>}
    </View>}
    ListFooterComponent={footer}
    ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
    extraData={visibleRows}
    onViewableItemsChanged={onViewableItemsChanged}
    initialNumToRender={4}
    maxToRenderPerBatch={4}
    windowSize={5}
    keyExtractor={([file], index) => `${file.itemId}:${index}`}
    renderItem={({ item, index }) => (
      <View style={styles.pair}>
        {item.map((file, column) => (
          <Pressable key={column} accessibilityRole="button" accessibilityLabel={`Open ${file.title}, ${formatLabel[file.kind]}`} onPress={() => open(file)}
            style={({ pressed }) => [styles.card, styles.tile, { borderColor: colors.separator, backgroundColor: pressed ? colors.pressed : colors.surface }]}>
            <View style={[styles.cover, { aspectRatio: columns === 1 ? 16 / 9 : 4 / 3, borderColor: colors.separator }]}>
              <PreviewThumbnail file={file} agentId={agentId} visible={visibleRows.has(index)} renderDocument={renderDocument} />
            </View>
            <View style={styles.tileText}>
              <Text variant="secondary" color="textStrong" numberOfLines={2} maxFontSizeMultiplier={18 / 14} textBreakStrategy="simple" lineBreakStrategyIOS="none" style={styles.weight}>{file.title}</Text>
              <Text variant="caption" color="textMuted" numberOfLines={1} maxFontSizeMultiplier={16 / 12}>{formatLabel[file.kind]}{file.at ? ` · ${relativeTime(file.at)}` : ""}</Text>
            </View>
          </Pressable>
        ))}
        {Array.from({ length: columns - item.length }, (_, i) => <View key={`empty-${i}`} style={styles.tile} />)}
      </View>
    )}
  />;
}

function htmlDocument(html: string, background: string, authored = false) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src about:; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>*{box-sizing:border-box}html{background:${background};${authored ? "color-scheme:light" : ""}}body{margin:0}iframe{${authored ? "color-scheme:light dark;" : ""}border:0;width:100vw;height:100dvh;display:block}</style><iframe title="Lodestar Preview" sandbox="allow-scripts" srcdoc="${escapeHtml(html)}"></iframe>`;
}

type OpenPreview = { file: Preview; content?: MobilePreview; error?: string; thumbnail?: boolean };

export function usePreview(agentId: string, files: readonly Preview[] = []) {
  const [selected, setSelected] = useState<OpenPreview | null>(null);
  const open = useCallback(async (file: Preview) => {
    const request = { file, content: "content" in file ? file.content : undefined };
    setSelected(request);
    if (!("target" in file)) return;
    try {
      const content = client.status !== "online"
        ? file.kind === "image" && file.thumb ? undefined : cachedThumbnail(agentId, file.itemId, file.target)
        : await client.call("mobile.preview", { agentId, itemId: file.itemId, target: file.target });
      if (!content) throw new Error("Connect to your Mac to open this file.");
      setSelected((current) => current === request ? { file, content } : current);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not load the file.";
      const message = detail.includes("cannot call mobile.preview") ? "Update Lodestar on your Mac to open workspace files." : detail;
      const next: OpenPreview = file.kind === "image" && file.thumb ? { file, content: { kind: "image", uri: file.thumb }, thumbnail: true } : { file, error: message };
      setSelected((current) => current === request ? next : current);
    }
  }, [agentId]);
  const close = useCallback(() => setSelected(null), []);
  return { agentId, files, selected, open, close };
}

function PreviewContent({ content, title, tile, onImageError }: { content: MobilePreview; title: string; tile?: { width: number; height: number }; onImageError?: () => void }) {
  const colors = useColors();
  const [failedUri, setFailedUri] = useState<string>();
  const [loadedDocument, setLoadedDocument] = useState<string>();
  const width = tile?.width;
  const height = tile?.height;
  const document = useMemo(() => {
    switch (content.kind) {
      case "html": return width && height ? thumbnailDocument(content.html, width, height, palette.light.surface) : htmlDocument(content.html, palette.light.surface, true);
      case "svg": return htmlDocument(vectorDocument(content.text, palette.light.surfaceBase, 8), palette.light.surfaceBase);
      case "csv": return htmlDocument(spreadsheet(content.text, colors), colors.surface);
      default: return undefined;
    }
  }, [content, colors, width, height]);
  const source = useMemo(() => document ? { html: document, baseUrl: "about:blank" } : undefined, [document]);
  if (content.kind === "image") {
    if (failedUri === content.uri) return <View style={styles.center}><Text color="textMuted">Could not display this image.</Text></View>;
    return <Image source={{ uri: content.uri }} accessibilityLabel={title} onError={() => { setFailedUri(content.uri); onImageError?.(); }} resizeMode="contain" style={StyleSheet.absoluteFill} />;
  }
  if (content.kind === "markdown") return <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.document}><MarkdownView text={content.text} /></ScrollView>;
  return <WebView javaScriptEnabled={!tile && content.kind === "html"} scrollEnabled={!tile && content.kind !== "svg"} source={source}
    containerStyle={{ backgroundColor: colors.surfaceBase, ...(tile ? { borderWidth: 1, borderColor: colors.separator } : {}) }}
    style={{ backgroundColor: colors.surfaceBase, opacity: loadedDocument === document ? 1 : 0 }}
    onLoadEnd={() => setLoadedDocument(document)} forceDarkOn={false} originWhitelist={["*"]}
    onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url === "about:srcdoc"} onOpenWindow={() => {}} allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} domStorageEnabled={false} geolocationEnabled={false} incognito mixedContentMode="never" />;
}

function samePreview(left: Preview, right: Preview) {
  if (left === right) return true;
  if (left.itemId !== right.itemId) return false;
  return "target" in left ? "target" in right && left.target === right.target : "content" in right && left.content === right.content;
}

export function PreviewModal({ selected, close, open, files, agentId }: ReturnType<typeof usePreview>) {
  if (!selected) return null;
  return <PreviewViewer {...selected} files={files} agentId={agentId} open={open} close={close} />;
}

type ImageTransform = { zoom: number; x: number; y: number };
const initialTransform = { zoom: 1, x: 0, y: 0 };

function PreviewViewer({ file, content: original, error, thumbnail, files, agentId, close, open }: OpenPreview & {
  files: readonly Preview[];
  agentId: string;
  close: () => void;
  open: (file: Preview) => void;
}) {
  const colors = useColors();
  const { expanded } = useFoldLayout();
  const full = useExpandedPreview() === agentId && expanded;
  useEffect(() => () => releasePreview(agentId), [agentId]);
  const exactIndex = files.findIndex(candidate => samePreview(candidate, file));
  const pathIndex = file.path ? files.findIndex(candidate => candidate.path === file.path) : -1;
  const rail = exactIndex >= 0 || pathIndex >= 0 ? files : [file, ...files];
  const index = Math.max(0, exactIndex >= 0 ? exactIndex : pathIndex);
  const [hidden, setHidden] = useState(false);
  const [reload, setReload] = useState(0);
  const [failedImage, setFailedImage] = useState<MobilePreview>();
  const [failedFallback, setFailedFallback] = useState<MobilePreview>();
  const failed = !!original && failedImage === original;
  const fallback = failed && original.kind === "image" && file.thumb && original.uri !== file.thumb ? file.thumb : undefined;
  const content: MobilePreview | undefined = fallback ? { kind: "image", uri: fallback } : original;
  const failure = error ?? (failed && (!fallback || failedFallback === original) ? "Could not display this image." : undefined);
  const keyboard = useKeyboardTop() !== undefined;
  const [magnification, setMagnification] = useState<{ file: Preview; transform: ImageTransform }>();
  const transform = magnification?.file === file ? magnification.transform : initialTransform;
  const bounds = useRef({ width: 0, height: 0 });
  const gesture = useRef<{ x: number; y: number; distance: number; moved: boolean; transform: ImageTransform } | null>(null);
  const tap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const strip = useRef<FlatList<Preview>>(null);
  const { visible: visibleThumbs, onViewableItemsChanged } = useVisibleRows();
  const image = content?.kind === "image" || content?.kind === "svg";
  const showStrip = !hidden && !keyboard && rail.length > 1;

  useEffect(() => () => { if (tap.current) clearTimeout(tap.current); }, []);

  useEffect(() => {
    if (showStrip) strip.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  }, [showStrip, index]);

  const setTransform = (scale: number, x = 0, y = 0) => {
    const zoom = Math.max(1, Math.min(4, scale));
    const maxX = bounds.current.width * (zoom - 1) / 2;
    const maxY = bounds.current.height * (zoom - 1) / 2;
    setMagnification({ file, transform: { zoom, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) } });
  };
  const distance = ({ nativeEvent: { touches } }: GestureResponderEvent) => touches.length === 2
    ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) : 0;
  const start = (event: GestureResponderEvent) => {
    const { pageX: x, pageY: y } = event.nativeEvent;
    const span = distance(event);
    gesture.current = { x, y, distance: span, moved: span > 0, transform };
  };
  const move = (event: GestureResponderEvent) => {
    const initial = gesture.current;
    if (!initial) return;
    const span = distance(event);
    if (span > 0) {
      initial.moved = true;
      if (!initial.distance) {
        initial.distance = span;
        initial.transform = transform;
      }
      setTransform(initial.transform.zoom * span / initial.distance, initial.transform.x, initial.transform.y);
    } else if (!initial.distance && event.nativeEvent.touches.length === 1) {
      const dx = event.nativeEvent.pageX - initial.x;
      const dy = event.nativeEvent.pageY - initial.y;
      if (Math.hypot(dx, dy) > 8) initial.moved = true;
      if (initial.moved && initial.transform.zoom > 1) setTransform(initial.transform.zoom, initial.transform.x + dx, initial.transform.y + dy);
    }
  };
  const finish = () => {
    const initial = gesture.current;
    gesture.current = null;
    if (!initial || initial.moved) return;
    if (tap.current) {
      clearTimeout(tap.current);
      tap.current = null;
      setTransform(transform.zoom > 1 ? 1 : 2);
      return;
    }
    tap.current = setTimeout(() => { tap.current = null; setHidden(value => !value); }, 250);
  };
  useFocusEffect(useCallback(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => { if (full) releasePreview(agentId); else close(); return true; });
    return () => back.remove();
  }, [agentId, close, full]));

  const details = () => {
    const path = file.path;
    Alert.alert(file.title, undefined, [
      ...(file.kind === "html" ? [{ text: "Reload", onPress: () => { setReload(value => value + 1); void open(file); } }] : []),
      ...(path ? [{ text: "Copy file path", onPress: () => { void Clipboard.setStringAsync(path); } }] : []),
      { text: "Cancel", style: "cancel" },
    ]);
  };
  const retry = () => {
    setFailedImage(undefined);
    setFailedFallback(undefined);
    setReload(value => value + 1);
    void open(file);
  };
  const body = content && <PreviewContent key={`${index}:${reload}`} content={content} title={file.title}
    onImageError={() => { if (fallback) setFailedFallback(original); else setFailedImage(original); }} />;
  return (
    <View accessibilityViewIsModal onAccessibilityEscape={close} style={[StyleSheet.absoluteFill, { backgroundColor: colors.surfaceBase }]}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.surfaceBase }]}>
        {!hidden && <View style={[styles.bar, { backgroundColor: colors.background, borderColor: colors.separator }]}>
          <PreviewControl icon="xmark" label="Close preview" action={close} />
          <View style={styles.title}>
            <Text variant="title" color="textStrong" numberOfLines={1}>{file.title}</Text>
            <Text variant="caption" color="textMuted" numberOfLines={1}>{formatLabel[file.kind]}{rail.length > 1 ? ` · ${index + 1} of ${rail.length}` : ""}</Text>
          </View>
          {expanded && <PreviewControl icon={full ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"} label={full ? "Exit full screen" : "Full screen"} action={() => expandPreview(full ? null : agentId)} />}
          {(file.kind === "html" || !!file.path) && <PreviewControl icon="ellipsis" label="Preview options" action={details} />}
        </View>}
        {!hidden && (thumbnail || fallback) && <View style={styles.notice}>
          <Text variant="caption" color="textMuted">Showing a smaller copy. <Text variant="caption" color="accentText" accessibilityRole="link" onPress={retry}>Try again</Text></Text>
        </View>}
        {failure ? <View style={styles.center}>
          <Text color="textMuted" style={styles.centerText}>{failure}</Text>
          <Button title="Try again" onPress={retry} />
        </View> : !content ? <View style={styles.center}><ActivityIndicator color={colors.accentText} accessibilityLabel="Loading preview" /></View>
          : image ? <View style={styles.image}
            onLayout={({ nativeEvent }) => { bounds.current = nativeEvent.layout; }}
            onStartShouldSetResponder={() => true}
            onResponderGrant={start}
            onTouchStart={event => { if (event.nativeEvent.touches.length === 2) start(event); }}
            onResponderMove={move}
            onResponderRelease={finish}
            onResponderTerminate={() => { gesture.current = null; }}
            accessibilityActions={[{ name: "activate", label: "Toggle preview controls" }]}
            onAccessibilityAction={() => setHidden(value => !value)}>
            <View pointerEvents="none" style={[styles.fill, { transform: [{ translateX: transform.x }, { translateY: transform.y }, { scale: transform.zoom }] }]}>{body}</View>
          </View> : <View style={styles.fill}>{body}</View>}
        {showStrip && <FlatList
          ref={strip} horizontal data={rail} showsHorizontalScrollIndicator={false}
          extraData={visibleThumbs} onViewableItemsChanged={onViewableItemsChanged}
          style={[styles.navigation, { backgroundColor: colors.background, borderColor: colors.separator }]}
          contentContainerStyle={styles.stripContent}
          getItemLayout={(_, position) => ({ length: 48, index: position, offset: 56 * position + 16 })}
          ItemSeparatorComponent={() => <View style={{ width: 8 }} />}
          keyExtractor={(candidate, position) => `${candidate.itemId}:${position}`}
          renderItem={({ item, index: position }) => <Pressable accessibilityRole="button" accessibilityLabel={item.title}
            accessibilityState={{ selected: index === position }} onPress={() => { setHidden(false); setMagnification(undefined); void open(item); }}
            style={[styles.ring, { borderColor: index === position ? colors.accent : "transparent" }]}>
            <View style={styles.stripThumb}><PreviewThumbnail agentId={agentId} file={item} visible={visibleThumbs.has(position)} renderDocument={renderDocument} /></View>
          </Pressable>}
        />}
      </SafeAreaView>
    </View>
  );
}

function PreviewControl({ icon, label, action }: { icon: ComponentProps<typeof Icon>["name"]; label: string; action?: () => void }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !action }} disabled={!action} onPress={action}
    style={({ pressed }) => [styles.control, { backgroundColor: pressed ? colors.pressed : undefined, opacity: action ? 1 : 0.4 }]}>
    <Icon name={icon} color="textStrong" size={20} />
  </Pressable>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  card: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  gallery: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  pair: { flexDirection: "row", gap: spacing.md },
  tile: { flex: 1, minWidth: 0 },
  cover: { borderBottomWidth: StyleSheet.hairlineWidth },
  tileText: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 },
  row: { minHeight: 64, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.md },
  thumb: { width: 48, height: 48, borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  title: { flex: 1, minWidth: 0 },
  bar: { minHeight: 56, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.xs },
  navigation: { height: 64, flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth },
  control: { width: 48, height: 48, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl, gap: spacing.md },
  document: { width: "100%", maxWidth: 720, alignSelf: "center", padding: spacing.lg },
  galleryHead: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  weight: { fontWeight: "600" },
  chips: { marginHorizontal: -16, marginBottom: 12 },
  chipContent: { paddingHorizontal: 16, gap: 8 },
  chip: { minHeight: 36, borderRadius: 18, paddingHorizontal: 12, justifyContent: "center" },
  chipLabel: { fontWeight: "600", fontSize: 13 },
  rowTitle: { fontSize: 15, lineHeight: 21 },
  emptyGallery: { alignItems: "center", gap: 8, paddingVertical: 40 },
  centerText: { textAlign: "center" },
  notice: { minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  stripContent: { paddingHorizontal: 16, alignItems: "center" },
  ring: { width: 48, height: 48, borderWidth: 2, borderRadius: 8 },
  stripThumb: { flex: 1, overflow: "hidden", borderRadius: 6 },
  image: { flex: 1, overflow: "hidden" },
});
