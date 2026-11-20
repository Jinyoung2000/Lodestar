import * as Clipboard from "expo-clipboard";
import { memo, useCallback, useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { isOpenableLink, parseMarkdown, type Token } from "../logic/markdown";
import { radius, spacing, useColors } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

// 마크다운을 React Native 로 그린다. 문단과 목록과 인용은 글자 크기가 Dynamic Type 을 따르고,
// 코드 블록과 표는 가로로 스크롤한다(줄바꿈하지 않아 들여쓰기가 유지된다). 같은 글의 파싱은 logic/markdown.ts 가 기억한다.

type Tokens = Token[] | undefined;
type Any = Token & Record<string, unknown>;

export const MarkdownView = memo(function MarkdownView({ text, selectable = true }: { text: string; selectable?: boolean }) {
  const tokens = parseMarkdown(text);
  return (
    <View>
      {tokens.map((token, index) => (
        <Block key={index} token={token as Any} selectable={selectable} last={index === tokens.length - 1} />
      ))}
    </View>
  );
});

function Block({ token, selectable, last }: { token: Any; selectable: boolean; last: boolean }): ReactNode {
  const colors = useColors();
  const gap = last ? 0 : spacing.md;
  switch (token.type) {
    case "paragraph":
    case "text":
      return (
        <Text selectable={selectable} style={{ marginBottom: gap }}>
          <Inline tokens={token.tokens as Tokens} fallback={String(token.text ?? "")} />
        </Text>
      );
    case "heading": {
      const depth = Number(token.depth);
      const size = depth === 1 ? 22 : depth === 2 ? 20 : depth === 3 ? 18 : 16;
      return (
        <Text selectable={selectable} color="textStrong" style={{ fontSize: size, lineHeight: Math.round(size * 1.35), fontWeight: "700", marginTop: spacing.xs, marginBottom: Math.max(gap, spacing.sm) }}>
          <Inline tokens={token.tokens as Tokens} fallback={String(token.text ?? "")} />
        </Text>
      );
    }
    case "code":
      return <CodeBlock code={String(token.text ?? "")} lang={typeof token.lang === "string" ? token.lang : ""} marginBottom={gap} />;
    case "list":
      return <List token={token} selectable={selectable} marginBottom={gap} />;
    case "blockquote":
      return (
        <View style={{ flexDirection: "row", marginBottom: gap }}>
          <View style={{ width: 3, borderRadius: 2, backgroundColor: colors.border, marginRight: spacing.md }} />
          <View style={{ flex: 1 }}>
            {(token.tokens as Token[]).map((t, i, all) => (
              <Block key={i} token={t as Any} selectable={selectable} last={i === all.length - 1} />
            ))}
          </View>
        </View>
      );
    case "hr":
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.sm, marginBottom: gap }} />;
    case "table":
      return <Table token={token} marginBottom={gap} />;
    case "space":
      return null;
    default:
      // html 같은 나머지는 글자 그대로 보인다
      return typeof token.raw === "string" && token.raw.trim() ? (
        <Text selectable={selectable} style={{ marginBottom: gap }}>
          {token.raw.trim()}
        </Text>
      ) : null;
  }
}

// 인라인: 굵게, 기울임, 코드, 링크, 취소선, 줄바꿈. 안쪽 Text 는 바깥 문단의 글자 크기를 그대로 상속한다.
function Inline({ tokens, fallback }: { tokens: Tokens; fallback: string }): ReactNode {
  const colors = useColors();
  if (!tokens || tokens.length === 0) return <>{fallback}</>;
  return (
    <>
      {tokens.map((raw, i) => {
        const t = raw as Any;
        switch (t.type) {
          case "strong":
            return (
              <Text key={i} variant="bodyStrong" color="textStrong" style={{ fontSize: undefined, lineHeight: undefined }}>
                <Inline tokens={t.tokens as Tokens} fallback={String(t.text ?? "")} />
              </Text>
            );
          case "em":
            return (
              <Text key={i} style={{ fontStyle: "italic", fontSize: undefined, lineHeight: undefined }}>
                <Inline tokens={t.tokens as Tokens} fallback={String(t.text ?? "")} />
              </Text>
            );
          case "del":
            return (
              <Text key={i} style={{ textDecorationLine: "line-through", fontSize: undefined, lineHeight: undefined }}>
                <Inline tokens={t.tokens as Tokens} fallback={String(t.text ?? "")} />
              </Text>
            );
          case "codespan":
            return (
              <Text key={i} variant="mono" style={{ color: colors.inlineCodeText, backgroundColor: colors.inlineCodeBackground, fontSize: 14, lineHeight: undefined }}>
                {`\u00a0${String(t.text ?? "")}\u00a0`}
              </Text>
            );
          case "link": {
            const href = t.href;
            // 열 수 없는 주소는 링크로 보이지 않고 글자만 남는다
            if (!isOpenableLink(href)) return <Inline key={i} tokens={t.tokens as Tokens} fallback={String(t.text ?? "")} />;
            return (
              <Text key={i} color="accentText" style={{ textDecorationLine: "underline", fontSize: undefined, lineHeight: undefined }} onPress={() => void Linking.openURL(href).catch(() => {})}>
                <Inline tokens={t.tokens as Tokens} fallback={String(t.text ?? t.href ?? "")} />
              </Text>
            );
          }
          case "br":
            return "\n";
          case "image":
            return (
              <Text key={i} color="textMuted" style={{ fontSize: undefined, lineHeight: undefined }}>
                {`[image: ${String(t.text || t.href || "")}]`}
              </Text>
            );
          case "escape":
          case "text":
            return t.tokens ? <Inline key={i} tokens={t.tokens as Tokens} fallback={String(t.text ?? "")} /> : decode(String(t.text ?? ""));
          default:
            return typeof t.raw === "string" ? t.raw : null;
        }
      })}
    </>
  );
}

// marked 는 인라인 text 의 &amp; 같은 엔티티를 그대로 남긴다
function decode(text: string) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function List({ token, selectable, marginBottom }: { token: Any; selectable: boolean; marginBottom: number }) {
  const items = token.items as Any[];
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <View style={{ marginBottom }}>
      {items.map((item, index) => {
        const marker = token.ordered ? `${start + index}.` : item.task ? (item.checked ? "☑" : "☐") : "•";
        return (
          <View key={index} style={{ flexDirection: "row", marginBottom: index === items.length - 1 ? 0 : spacing.xs }}>
            <Text color={token.ordered ? "textMuted" : "textMuted"} style={{ width: token.ordered ? 28 : 20 }}>
              {marker}
            </Text>
            <View style={{ flex: 1 }}>
              {(item.tokens as Token[]).map((t, i, all) => (
                <Block key={i} token={t as Any} selectable={selectable} last={i === all.length - 1 || (t as Any).type === "text"} />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const CODE_PREVIEW_LINES = 40;

// 코드 블록: 고정폭, 가로 스크롤, 긴 블록은 40줄까지만 보이고 펼친다. 길게 눌러 복사할 필요 없이 복사 단추가 있다.
function CodeBlock({ code, lang, marginBottom }: { code: string; lang: string; marginBottom: number }) {
  const colors = useColors();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lines = code.split("\n");
  const clipped = !expanded && lines.length > CODE_PREVIEW_LINES;
  const shown = clipped ? lines.slice(0, CODE_PREVIEW_LINES).join("\n") : code;
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);
  return (
    <View style={{ marginBottom, borderRadius: radius.md, backgroundColor: colors.codeBackground, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: spacing.md, minHeight: 36 }}>
        <Text variant="caption" color="textMuted" style={{ flex: 1 }}>
          {lang || "code"}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy code" hitSlop={8} onPress={copy} style={{ paddingHorizontal: spacing.md, minHeight: 36, justifyContent: "center", flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={copied ? "checkmark" : "doc.on.doc"} size={14} color={copied ? "success" : "textMuted"} />
          <Text variant="caption" color={copied ? "success" : "textMuted"}>
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }} nestedScrollEnabled>
        <Text variant="mono" selectable style={{ fontSize: 14, lineHeight: 21 }}>
          {shown}
        </Text>
      </ScrollView>
      {clipped && (
        <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} style={{ minHeight: 44, alignItems: "center", justifyContent: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator }}>
          <Text variant="secondary" color="accentText">{`Show all ${lines.length} lines`}</Text>
        </Pressable>
      )}
    </View>
  );
}

// 한글과 한자는 영문보다 넓다. 표 열 너비를 글자 종류로 어림한다(14pt 기준).
function textWidth(text: string) {
  let width = 0;
  for (const ch of text) width += /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u4e00-\u9fff\uac00-\ud7af]/.test(ch) ? 15 : /[A-Z0-9]/.test(ch) ? 10 : 8;
  return width;
}

function Table({ token, marginBottom }: { token: Any; marginBottom: number }) {
  const colors = useColors();
  const header = token.header as { text: string; tokens: Token[] }[];
  const rows = token.rows as { text: string; tokens: Token[] }[][];
  const widths = header.map((h, c) => Math.min(260, Math.max(80, 28 + Math.max(textWidth(h.text), ...rows.map((r) => textWidth(r[c]?.text ?? ""))))));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom }} nestedScrollEnabled>
      <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.sm, overflow: "hidden" }}>
        {[header, ...rows].map((row, r) => (
          <View key={r} style={{ flexDirection: "row", backgroundColor: r === 0 ? colors.surfaceBase : "transparent", borderTopWidth: r === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: colors.separator }}>
            {row.map((cell, c) => (
              <View key={c} style={{ width: widths[c], padding: spacing.sm, borderLeftWidth: c === 0 ? 0 : StyleSheet.hairlineWidth, borderLeftColor: colors.separator }}>
                <Text variant="secondary" color={r === 0 ? "textStrong" : "text"} style={{ fontWeight: r === 0 ? "600" : "400" }}>
                  <Inline tokens={cell.tokens as Tokens} fallback={cell.text} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

