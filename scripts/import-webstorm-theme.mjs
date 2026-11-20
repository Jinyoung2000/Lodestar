// JetBrains New UI(Dark, Light) 색을 tokens.json 의 `webstorm-dark` / `webstorm-light` 키로 옮기고 design-system/webstorm-theme.md 를 다시 쓴다.
// 사용: node scripts/import-webstorm-theme.mjs <원본 폴더>
// 원본 폴더에는 intellij-community master 의 expUI_dark.theme.json, expUI_light.theme.json, expUI_darkScheme.xml, expUI_lightScheme.xml,
// DefaultColorSchemesManager.xml(Default, Darcula 스키마)가 있어야 한다. 빌드는 이 폴더에 기대지 않는다. 읽는 쪽은 커밋된 tokens.json 뿐이다.
// 값이 Lodestar 기본과 같거나 대응하는 JetBrains 키가 없는 토큰은 키를 만들지 않는다(기본 값이 그대로 쓰인다).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_FILE = join(root, "design-system/tokens.json");
const DOC_FILE = join(root, "design-system/webstorm-theme.md");

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("사용: node scripts/import-webstorm-theme.mjs <원본 폴더>");
  const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  const sources = loadSources(dir);

  // 이전 실행이 남긴 키를 지우고 다시 계산한다(재실행해도 같은 결과).
  for (const token of tokens.color.tokens) {
    delete token.value["webstorm-dark"];
    delete token.value["webstorm-light"];
  }
  const rows = [];
  for (const mode of ["dark", "light"]) {
    const resolver = makeResolver(mode, sources[mode], tokens);
    for (const [name] of MAPPING) {
      const resolved = resolver.override(name);
      if (!resolved) continue;
      const token = tokens.color.tokens.find((t) => t.name === name);
      token.value[`webstorm-${mode}`] = resolved.value;
      rows.push({ name, mode, ...resolved });
    }
  }
  // 스타일 목록 메타데이터. 생성기는 lodestar 가 아닌 스타일마다 [data-style] 블록을 낸다.
  tokens.color.styles = [
    { id: "lodestar", name: "Lodestar" },
    { id: "webstorm", name: "WebStorm" },
  ];
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2) + "\n");
  const contrast = contrastReport(tokens);
  writeFileSync(DOC_FILE, renderDoc(tokens, rows, contrast));
  const count = (mode) => rows.filter((r) => r.mode === mode).length;
  console.log(`webstorm-dark ${count("dark")}개, webstorm-light ${count("light")}개 -> tokens.json, ${DOC_FILE}`);
  for (const line of contrast.misses) console.log(`대비 미달: ${line}`);
}

// 토큰 이름 -> 출처. 출처 문자열 문법(대안은 " | " 로 이어 앞에서부터 처음 값이 있는 것):
//   ui:키          theme.json 의 ui 평탄화 키(`*.background` 는 와일드카드 항목). 값이 팔레트 이름이면 colors 로 푼다
//   pal:이름       theme.json 의 colors 팔레트
//   sc:키          에디터 스킴 <colors> 의 항목(스킴, 부모 스킴 순)
//   at:이름.필드   에디터 스킴 <attributes> 의 항목 필드. baseAttributes 와 부모 스킴을 따라간다
//   tok:이름       같은 테마에서 그 토큰이 최종으로 갖는 값(덮어썼으면 WebStorm 값, 아니면 기본 값)
//   a(출처,알파)   출처 색에 알파를 곱한다(기존 토큰이 쓰는 파생과 같은 방식)
// {d, l} 로 밝기마다 다른 출처를 줄 수 있다.
const SEL = "ui:*.selectionBackground";
const SEL_FG = "ui:*.selectionForeground";
const SEL_INACTIVE = "ui:*.selectionInactiveBackground";
const HOVER = "ui:*.hoverBackground";
const TEXT_BG = "at:TEXT.BACKGROUND";
const FIELD_BG = "ui:TextField.background";
const FIELD_BORDER = "ui:Component.borderColor";
const PLACEHOLDER = "ui:*.infoForeground";
const MATCH_FG = "ui:CompletionPopup.matchForeground";
const TOOLTIP_BG = "ui:Editor.ToolTip.background";
const TOOLTIP_BORDER = "ui:Editor.ToolTip.border";
const SEARCH_HIT = "at:TEXT_SEARCH_RESULT_ATTRIBUTES.BACKGROUND";
const WRITE_CARET = "at:WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES";

const MAPPING = [
  // 면
  ["surface-base", "ui:*.background"],
  ["surface-raised", { d: "pal:Gray3", l: "pal:Gray14" }],
  ["chrome-bg", "ui:ToolWindow.background | ui:*.background"],
  ["pane-bg", TEXT_BG],
  ["aux-bg", TEXT_BG],
  ["surface-overlay", "ui:Popup.background | ui:*.background"],
  ["surface-hover", HOVER],
  ["surface-selected", SEL_INACTIVE],
  ["surface-inset", "ui:List.Tag.background"],
  ["border-subtle", "ui:*.separatorColor"],
  ["border", FIELD_BORDER],
  // 글자
  ["fg-strong", { d: "pal:Gray13", l: "pal:Gray1" }],
  ["fg", "ui:*.foreground | ui:CompletionPopup.foreground"],
  ["fg-muted", "ui:StatusBar.Widget.foreground"],
  ["fg-subtle", "ui:*.infoForeground"],
  ["activity-fg", "tok:fg"],
  ["activity-fg-muted", "ui:ToolWindow.Button.foreground"],
  // 강조와 상태
  ["accent", "ui:Button.default.startBackground"],
  ["focus-border", "ui:*.focusColor"],
  ["accent-fg", "ui:Button.default.foreground"],
  ["accent-text", "ui:Link.activeForeground"],
  ["running", "ui:ProgressBar.progressColor"],
  ["success", "ui:Badge.greenOutlineForeground"],
  ["warning", "ui:Label.warningForeground"],
  ["danger", "ui:Label.errorForeground"],
  // diff
  ["diff-add-bg", "at:DIFF_INSERTED.BACKGROUND"],
  ["diff-add-gutter", "at:DIFF_INSERTED.ERROR_STRIPE_COLOR"],
  ["diff-del-bg", "at:DIFF_DELETED.BACKGROUND"],
  ["diff-del-gutter", "at:DIFF_DELETED.ERROR_STRIPE_COLOR"],
  // 구문 색
  ["syntax-keyword", "at:DEFAULT_KEYWORD.FOREGROUND"],
  ["syntax-keyword-control", "at:DEFAULT_KEYWORD.FOREGROUND"],
  ["syntax-function", "at:DEFAULT_FUNCTION_DECLARATION.FOREGROUND"],
  ["syntax-type", "at:DEFAULT_CLASS_NAME.FOREGROUND | at:DEFAULT_IDENTIFIER.FOREGROUND"],
  ["syntax-string", "at:DEFAULT_STRING.FOREGROUND"],
  ["syntax-comment", "at:DEFAULT_LINE_COMMENT.FOREGROUND"],
  ["syntax-variable", "at:DEFAULT_IDENTIFIER.FOREGROUND"],
  ["syntax-constant", "at:DEFAULT_CONSTANT.FOREGROUND"],
  ["syntax-number", "at:DEFAULT_NUMBER.FOREGROUND"],
  ["syntax-regexp", "at:JS.REGEXP.FOREGROUND"],
  ["syntax-escape", "at:DEFAULT_VALID_STRING_ESCAPE.FOREGROUND"],
  ["syntax-operator", "at:DEFAULT_OPERATION_SIGN.FOREGROUND | at:TEXT.FOREGROUND"],
  ["syntax-tag", "at:HTML_TAG_NAME.FOREGROUND | at:XML_TAG_NAME.FOREGROUND | at:DEFAULT_KEYWORD.FOREGROUND"],
  ["syntax-tag-bracket", "at:XML_TAG.FOREGROUND | tok:syntax-tag"],
  ["syntax-attribute", "at:XML_ATTRIBUTE_NAME.FOREGROUND | at:DEFAULT_ATTRIBUTE.FOREGROUND"],
  ["syntax-selector", "tok:syntax-tag"],
  ["syntax-value", "at:CSS.COLOR.FOREGROUND | at:DEFAULT_IDENTIFIER.FOREGROUND"],
  ["syntax-json-key", "at:JSON.PROPERTY_KEY.FOREGROUND | at:DEFAULT_INSTANCE_FIELD.FOREGROUND"],
  // 에디터
  ["editor-bg", TEXT_BG],
  ["editor-fg", "at:TEXT.FOREGROUND"],
  ["editor-line-number", "sc:LINE_NUMBERS_COLOR"],
  ["editor-line-number-active", "sc:LINE_NUMBER_ON_CARET_ROW_COLOR"],
  ["editor-selection", "sc:SELECTION_BACKGROUND"],
  ["editor-selection-inactive", SEL_INACTIVE],
  ["editor-line-highlight", "sc:CARET_ROW_COLOR"],
  ["editor-cursor", "sc:CARET_COLOR"],
  ["editor-cursor-text", "tok:editor-bg"],
  ["editor-bracket-match-bg", "at:MATCHED_BRACE_ATTRIBUTES.BACKGROUND"],
  ["editor-bracket-unexpected", "at:UNMATCHED_BRACE_ATTRIBUTES.FOREGROUND"],
  ["editor-indent-guide", "sc:INDENT_GUIDE"],
  ["editor-indent-guide-active", "sc:SELECTED_INDENT_GUIDE"],
  ["editor-whitespace", "sc:WHITESPACES"],
  ["editor-fold-bg", "at:FOLDED_TEXT_ATTRIBUTES.BACKGROUND"],
  ["editor-fold-placeholder", "at:FOLDED_TEXT_ATTRIBUTES.FOREGROUND"],
  ["editor-fold-control", "tok:editor-line-number"],
  ["editor-link-active", "at:CTRL_CLICKABLE.FOREGROUND"],
  ["editor-error", "at:ERRORS_ATTRIBUTES.EFFECT_COLOR"],
  ["editor-warning", "at:WARNING_ATTRIBUTES.EFFECT_COLOR | at:WARNING_ATTRIBUTES.ERROR_STRIPE_COLOR"],
  ["editor-info", "at:INFO_ATTRIBUTES.EFFECT_COLOR"],
  ["editor-word-highlight", "at:IDENTIFIER_UNDER_CARET_ATTRIBUTES.BACKGROUND"],
  ["editor-word-highlight-strong", `${WRITE_CARET}.BACKGROUND`],
  ["editor-word-highlight-text", "at:IDENTIFIER_UNDER_CARET_ATTRIBUTES.BACKGROUND"],
  ["search-match-bg", SEARCH_HIT],
  ["scrollbar-slider", "sc:ScrollBar.Mac.thumbColor"],
  ["scrollbar-slider-hover", "sc:ScrollBar.Mac.hoverThumbColor"],
  // 채팅과 입력창
  ["chat-user-bg", "a(tok:editor-selection,0.3)"],
  ["chat-user-bg-hover", "a(tok:editor-selection,0.6)"],
  ["input-bg", FIELD_BG],
  ["input-border", FIELD_BORDER],
  ["row-selected", SEL],
  ["row-selected-inactive", SEL_INACTIVE],
  ["row-selected-fg", SEL_FG],
  ["list-muted-fg", "tok:fg-muted"],
  ["inline-code-bg", { d: "a(ui:Code.Inline.backgroundColor,0.15)", l: "a(ui:Code.Inline.backgroundColor,0.07)" }],
  ["inline-code-fg", "tok:fg"],
  ["code-block-bg", "tok:surface-base"],
  ["code-block-border", "ui:Code.Block.borderColor"],
  ["diff-count-add", "tok:success"],
  ["diff-count-del", "tok:danger"],
  ["git-added", "tok:success"],
  ["git-deleted", "tok:danger"],
  ["unread", "tok:accent-text"],
  ["status-spinner-running", "tok:accent-text"],
  ["status-spinner-waiting", "tok:warning"],
  ["pick-widget-bg", TOOLTIP_BG],
  ["pick-widget-border", TOOLTIP_BORDER],
  ["search-message-fg", "a(tok:fg,0.65)"],
  // Go to File
  ["quickinput-bg", "tok:surface-overlay"],
  ["quickinput-border", "ui:Popup.borderColor | ui:Component.borderColor"],
  ["quickinput-input-bg", FIELD_BG],
  ["quickinput-input-border", FIELD_BORDER],
  ["quickinput-placeholder", PLACEHOLDER],
  ["quickinput-selected-bg", SEL],
  ["quickinput-selected-fg", SEL_FG],
  ["quickinput-hover-bg", HOVER],
  ["quickinput-highlight", MATCH_FG],
  ["quickinput-group-border", "ui:*.separatorColor"],
  ["quickinput-description", "tok:fg-muted"],
  ["quickinput-action-hover", "ui:ActionButton.hoverBackground"],
  // hover, 자동완성, 찾기, 이름 바꾸기, 코드 액션
  ["hover-bg", "sc:DOCUMENTATION_COLOR"],
  ["hover-fg", "ui:Editor.ToolTip.foreground"],
  ["hover-border", TOOLTIP_BORDER],
  ["hover-highlight", MATCH_FG],
  ["hover-status-bg", "ui:Editor.ToolTip.selectionBackground"],
  ["hover-link", "ui:Link.activeForeground"],
  ["suggest-selected-bg", SEL],
  ["suggest-selected-fg", SEL_FG],
  ["find-widget-bg", "tok:surface-overlay"],
  ["find-widget-fg", "tok:fg"],
  ["find-widget-border", "tok:quickinput-border"],
  ["find-input-bg", FIELD_BG],
  ["find-input-border", FIELD_BORDER],
  ["find-input-placeholder", PLACEHOLDER],
  ["find-option-active-bg", "ui:SearchOption.selectedBackground"],
  ["find-option-active-border", "ui:*.focusColor"],
  ["find-option-active-fg", SEL_FG],
  ["find-option-hover-bg", "ui:ActionButton.hoverBackground"],
  ["find-button-hover-bg", "ui:ActionButton.hoverBackground"],
  ["find-disabled-fg", "ui:*.disabledForeground"],
  ["find-error-fg", "tok:danger"],
  ["find-error-bg", "ui:SearchField.errorBackground"],
  ["find-error-border", "ui:Component.errorFocusColor"],
  ["find-match-bg", "at:SEARCH_RESULT_ATTRIBUTES.BACKGROUND"],
  ["find-match-current-bg", SEARCH_HIT],
  ["find-ruler", "at:SEARCH_RESULT_ATTRIBUTES.ERROR_STRIPE_COLOR"],
  ["rename-widget-bg", "tok:surface-overlay"],
  ["rename-widget-fg", "tok:fg"],
  ["rename-widget-border", "tok:quickinput-border"],
  ["rename-input-bg", FIELD_BG],
  ["rename-input-border", FIELD_BORDER],
  ["action-widget-bg", "tok:surface-overlay"],
  ["action-widget-fg", "tok:fg"],
  ["action-widget-hover-bg", HOVER],
  ["action-widget-desc", "tok:fg-muted"],
  ["action-widget-disabled", "ui:*.disabledForeground"],
  ["action-widget-link", "tok:accent-text"],
  // 탭, 메뉴, 상태 줄, 이동 경로
  ["tab-drop-border", "ui:DragAndDrop.borderColor"],
  ["tab-strip-bg", "ui:EditorTabs.background"],
  ["tab-strip-border", "ui:EditorTabs.underTabsBorderColor | ui:*.separatorColor"],
  ["tab-active-bg", "ui:EditorTabs.underlinedTabBackground"],
  ["tab-hover-bg", HOVER],
  ["tab-hover-bg-unfocused", HOVER],
  ["tab-active-fg", "tok:fg"],
  ["tab-inactive-fg", "tok:fg-muted"],
  ["tab-inactive-fg-unfocused", "a(tok:fg-muted,0.5)"],
  ["group-drop-bg", "ui:ToolWindow.DragAndDrop.areaBackground"],
  ["menu-bg", "tok:surface-overlay"],
  ["menu-fg", "tok:fg"],
  ["menu-border", "ui:Menu.borderColor | ui:Menu.borderColor.os.default | ui:Popup.borderColor"],
  ["menu-selection-bg", SEL],
  ["menu-selection-fg", SEL_FG],
  ["menu-separator", "ui:Menu.separatorColor | ui:*.separatorColor"],
  ["input-error-bg", "ui:SearchField.errorBackground"],
  ["input-error-border", "ui:Component.errorFocusColor"],
  ["feedback-widget-bg", TOOLTIP_BG],
  ["feedback-widget-border", TOOLTIP_BORDER],
  ["feedback-glyph-bg", SEL_INACTIVE],
  ["peek-title-bg", "ui:ToolWindow.Header.inactiveBackground"],
  ["peek-title-fg", "tok:fg-strong"],
  ["peek-title-desc", "tok:fg-muted"],
  ["peek-result-bg", "tok:surface-overlay"],
  ["peek-result-line-fg", "tok:fg"],
  ["peek-result-file-fg", "tok:fg-strong"],
  ["peek-result-selection-bg", SEL],
  ["peek-result-selection-fg", SEL_FG],
  ["peek-result-selection-inactive-bg", SEL_INACTIVE],
  ["peek-result-match-bg", SEARCH_HIT],
  ["peek-editor-bg", "tok:editor-bg"],
  ["peek-editor-match-bg", SEARCH_HIT],
  ["peek-badge-bg", "ui:Counter.background"],
  ["peek-badge-fg", "ui:Counter.foreground"],
  ["statusbar-bg", "ui:StatusBar.background | ui:*.background"],
  ["statusbar-fg", "ui:StatusBar.Widget.foreground"],
  ["statusbar-border", "tok:border-subtle"],
  ["statusbar-item-hover-bg", "ui:StatusBar.Widget.hoverBackground | ui:ActionButton.hoverBackground"],
  ["statusbar-item-hover-fg", "ui:StatusBar.Widget.hoverForeground"],
  ["statusbar-item-active-bg", "ui:StatusBar.Widget.pressedBackground"],
  ["breadcrumb-fg", "ui:StatusBar.Breadcrumbs.foreground"],
  ["breadcrumb-fg-focus", "ui:StatusBar.Breadcrumbs.hoverForeground"],
  ["breadcrumb-picker-bg", "tok:surface-overlay"],
  ["breadcrumb-picker-border", "tok:quickinput-border"],
  ["breadcrumb-picker-hover", HOVER],
  ["sticky-hover-bg", HOVER],
  // 개요 눈금과 거터
  ["ruler-error", "at:ERRORS_ATTRIBUTES.ERROR_STRIPE_COLOR"],
  ["ruler-added", "a(sc:ADDED_LINES_COLOR,0.6)"],
  ["ruler-modified", "a(sc:MODIFIED_LINES_COLOR,0.6)"],
  ["ruler-deleted", "a(sc:DELETED_LINES_COLOR,0.6)"],
  ["ruler-border", "tok:border-subtle"],
  ["ruler-word-write", `${WRITE_CARET}.ERROR_STRIPE_COLOR`],
  ["editor-gutter-added", "sc:ADDED_LINES_COLOR"],
  ["editor-gutter-modified", "sc:MODIFIED_LINES_COLOR"],
  ["editor-gutter-deleted", "sc:DELETED_LINES_COLOR"],
  // 빠른 입력창
  ["quick-entry-bg", "a(tok:surface-overlay,0.93)"],
  ["quick-entry-border", "tok:quickinput-border"],
];

// 대비를 재는 쌍. [글자 토큰, 바탕 토큰들, 최소 비율]. 본문 글자는 4.5, 보조 글자와 구문 색은 3.
const CONTRAST_PAIRS = [
  ["fg", ["surface-base", "surface-raised", "chrome-bg", "pane-bg", "aux-bg", "surface-overlay", "input-bg"], 4.5],
  ["fg-strong", ["surface-base", "surface-raised", "chrome-bg", "pane-bg", "aux-bg", "surface-overlay"], 4.5],
  ["editor-fg", ["editor-bg"], 4.5],
  ["fg-muted", ["surface-base", "surface-raised", "chrome-bg", "pane-bg", "aux-bg", "surface-overlay"], 3],
  ["fg-subtle", ["surface-base", "surface-raised", "chrome-bg", "pane-bg", "aux-bg", "surface-overlay"], 3],
  ["accent-text", ["pane-bg", "aux-bg", "surface-overlay"], 3],
  ["accent-fg", ["accent"], 3],
  ["row-selected-fg", ["row-selected"], 4.5],
  ["editor-line-number", ["editor-bg"], 3],
  ["syntax-comment", ["editor-bg"], 3],
  ["syntax-keyword", ["editor-bg"], 3],
  ["syntax-string", ["editor-bg"], 3],
  ["syntax-number", ["editor-bg"], 3],
  ["syntax-function", ["editor-bg"], 3],
  ["syntax-constant", ["editor-bg"], 3],
  ["syntax-tag", ["editor-bg"], 3],
  ["syntax-attribute", ["editor-bg"], 3],
  ["syntax-regexp", ["editor-bg"], 3],
  ["syntax-escape", ["editor-bg"], 3],
  ["statusbar-fg", ["statusbar-bg"], 3],
  ["tab-inactive-fg", ["tab-strip-bg"], 3],
  ["menu-fg", ["menu-bg"], 4.5],
  ["hover-fg", ["hover-bg"], 4.5],
];

function loadSources(dir) {
  const read = (name) => readFileSync(join(dir, name), "utf8");
  const defaults = parseSchemes(read("DefaultColorSchemesManager.xml"));
  const mode = (id) => {
    const theme = JSON.parse(read(`expUI_${id}.theme.json`));
    const scheme = Object.values(parseSchemes(read(`expUI_${id}Scheme.xml`)))[0];
    return { theme, ui: flatten(theme.ui), chain: schemeChain(scheme, defaults) };
  };
  return { dark: mode("dark"), light: mode("light") };
}

// 최소 XML 파서: <scheme> 마다 <colors>, <attributes> 를 뽑는다. 값에 붙은 deuteranopia 같은 색각 변형 속성은 무시한다.
function parseSchemes(xml) {
  const schemes = {};
  for (const m of xml.matchAll(/<scheme\b([^>]*)>([\s\S]*?)<\/scheme>/g)) {
    const head = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const colors = {};
    const colorBlock = m[2].match(/<colors>([\s\S]*?)<\/colors>/);
    if (colorBlock) for (const o of colorBlock[1].matchAll(/<option name="([^"]+)" value="([^"]*)"/g)) colors[o[1]] = o[2];
    const attributes = {};
    const attributeBlock = m[2].match(/<attributes>([\s\S]*?)<\/attributes>/);
    if (attributeBlock) {
      const option = /<option name="([^"]+)"(?:\s+baseAttributes="([^"]*)")?\s*(?:\/>|>([\s\S]*?)<\/option>)/g;
      for (const a of attributeBlock[1].matchAll(option)) {
        const props = {};
        if (a[3]) for (const p of a[3].matchAll(/<option name="([^"]+)" value="([^"]*)"/g)) props[p[1]] = p[2];
        attributes[a[1]] = { base: a[2] ?? null, props };
      }
    }
    schemes[head.name] = { name: head.name, parent: head.parent_scheme ?? null, colors, attributes };
  }
  return schemes;
}

function schemeChain(scheme, defaults) {
  const chain = [];
  for (let s = scheme; s; s = s.parent ? defaults[s.parent] : null) chain.push(s);
  return chain;
}

// theme.json 의 ui 를 "A.B.c" 키 하나씩으로 편다. `*` 항목은 `*.background` 처럼 남는다.
function flatten(object, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

// 한 밝기(dark, light)에서 출처 문자열을 색으로 푸는 함수 묶음
function makeResolver(mode, source, tokens) {
  const memo = new Map();
  const visiting = new Set();
  const entries = new Map(MAPPING);

  // JetBrains XML 의 16진수는 앞자리 0 을 버린다(33b3 = #0033b3). 6자리(알파가 있으면 8자리)로 왼쪽을 0 으로 채운다.
  const padHex = (raw) => (raw.length > 6 ? raw.padStart(8, "0") : raw.padStart(6, "0"));

  const palette = (name) => source.theme.colors[name] ?? null;
  const fromUi = (key) => {
    const raw = source.ui[key];
    if (typeof raw !== "string") return null;
    return parseColor(palette(raw) ?? raw);
  };
  const fromScheme = (key) => {
    for (const scheme of source.chain) if (scheme.colors[key] !== undefined) return parseColor("#" + padHex(scheme.colors[key]));
    return null;
  };
  const attribute = (name, seen = new Set()) => {
    if (seen.has(name)) return null;
    seen.add(name);
    for (const scheme of source.chain) {
      const entry = scheme.attributes[name];
      if (!entry) continue;
      return entry.base ? attribute(entry.base, seen) : entry.props;
    }
    return null;
  };
  const fromAttribute = (spec) => {
    const dot = spec.lastIndexOf(".");
    const props = attribute(spec.slice(0, dot));
    const raw = props?.[spec.slice(dot + 1)];
    return raw === undefined ? null : parseColor("#" + padHex(raw));
  };
  const tokenColor = (name) => {
    const base = tokens.color.tokens.find((t) => t.name === name);
    if (!base) throw new Error(`tokens.json 에 없는 토큰 ${name}`);
    const own = override(name);
    return parseColor(own ? own.value : base.value[mode]);
  };

  // 출처 하나를 {color, source} 로 푼다. 값이 없으면 null.
  function one(spec) {
    const alpha = /^a\((.+),([0-9.]+)\)$/.exec(spec);
    if (alpha) {
      const inner = one(alpha[1]);
      return inner && { color: { ...inner.color, a: inner.color.a * Number(alpha[2]) }, source: spec };
    }
    const colon = spec.indexOf(":");
    const kind = spec.slice(0, colon);
    const rest = spec.slice(colon + 1);
    const color = kind === "ui" ? fromUi(rest) : kind === "pal" ? parseColor(palette(rest)) : kind === "sc" ? fromScheme(rest) : kind === "at" ? fromAttribute(rest) : kind === "tok" ? tokenColor(rest) : null;
    return color && { color, source: spec };
  }

  // 토큰 하나의 WebStorm 값. 출처가 없거나 기본 값과 같으면 null(키를 만들지 않는다).
  function override(name) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) throw new Error(`토큰 순환 ${name}`);
    const entry = entries.get(name);
    if (!entry) return null;
    const base = tokens.color.tokens.find((t) => t.name === name);
    if (!base) throw new Error(`tokens.json 에 없는 토큰 ${name}`);
    visiting.add(name);
    const raw = typeof entry === "string" ? entry : entry[mode === "dark" ? "d" : "l"];
    let result = null;
    for (const spec of raw.split(" | ")) {
      const hit = one(spec.trim());
      if (!hit) continue;
      result = { value: formatColor(hit.color), source: hit.source };
      break;
    }
    visiting.delete(name);
    if (result && sameColor(parseColor(result.value), parseColor(base.value[mode]))) result = null;
    memo.set(name, result);
    return result;
  }

  return { override };
}

// #rgb, #rrggbb, #rrggbbaa, rgb(), rgba() 를 {r,g,b,a(0~1)} 로
function parseColor(input) {
  if (!input) return null;
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let d = hex[1];
    if (d.length === 3 || d.length === 4) d = [...d].map((c) => c + c).join("");
    if (d.length !== 6 && d.length !== 8) return null;
    return { r: parseInt(d.slice(0, 2), 16), g: parseInt(d.slice(2, 4), 16), b: parseInt(d.slice(4, 6), 16), a: d.length === 8 ? parseInt(d.slice(6, 8), 16) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const p = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.every((n) => !Number.isNaN(n))) return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  return null;
}

function formatColor({ r, g, b, a }) {
  const h = (n) => Math.round(n).toString(16).padStart(2, "0");
  const alpha = Math.round(a * 255);
  return `#${h(r)}${h(g)}${h(b)}${alpha === 255 ? "" : h(alpha)}`;
}

const sameColor = (x, y) => x && y && Math.round(x.r) === Math.round(y.r) && Math.round(x.g) === Math.round(y.g) && Math.round(x.b) === Math.round(y.b) && Math.round(x.a * 255) === Math.round(y.a * 255);

function luminance({ r, g, b }) {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// 글자색(알파가 있으면 바탕 위에 섞는다)과 바탕색의 WCAG 대비
function contrast(fg, bg) {
  const mixed = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
  const [hi, lo] = [luminance(mixed), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function contrastReport(tokens) {
  const rows = [];
  const misses = [];
  for (const style of ["lodestar", "webstorm"]) {
    for (const mode of ["dark", "light"]) {
      const value = (name) => {
        const token = tokens.color.tokens.find((t) => t.name === name);
        return parseColor((style === "webstorm" ? token.value[`webstorm-${mode}`] : undefined) ?? token.value[mode]);
      };
      for (const [fg, bgs, min] of CONTRAST_PAIRS) {
        for (const bg of bgs) {
          const ratio = contrast(value(fg), value(bg));
          rows.push({ style, mode, fg, bg, min, ratio });
          if (style === "webstorm" && ratio < min) misses.push(`${mode} ${fg} on ${bg} = ${ratio.toFixed(2)} (< ${min})`);
        }
      }
    }
  }
  return { rows, misses };
}

function renderDoc(tokens, rows, contrast) {
  const order = tokens.color.tokens.map((t) => t.name);
  const names = [...new Set(rows.map((r) => r.name))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const cell = (name, mode) => {
    const r = rows.find((x) => x.name === name && x.mode === mode);
    return r ? `\`${r.value}\`` : "기본";
  };
  const sourceOf = (name) => {
    const d = rows.find((x) => x.name === name && x.mode === "dark")?.source;
    const l = rows.find((x) => x.name === name && x.mode === "light")?.source;
    if (d && l && d === l) return `\`${d}\``;
    return [d && `dark \`${d}\``, l && `light \`${l}\``].filter(Boolean).join(", ");
  };
  const count = (mode) => rows.filter((r) => r.mode === mode).length;
  const lines = [];
  lines.push("# WebStorm 색 스타일 매핑");
  lines.push("");
  lines.push('`settings.themeStyle = "webstorm"` 일 때 `<html data-style="webstorm">` 가 붙고, 아래 토큰만 `tokens.json` 의 `webstorm-dark`, `webstorm-light` 값으로 바뀐다. 밝기(Dark, Light, System)는 그대로 `settings.theme` 이 정한다.');
  lines.push("");
  lines.push("출처: intellij-community master 의 `expUI_dark.theme.json`, `expUI_light.theme.json`(UI 색), `expUI_darkScheme.xml`, `expUI_lightScheme.xml`(에디터 색, 없는 항목은 `DefaultColorSchemesManager.xml` 의 Darcula, Default 스키마). 이 파일은 `scripts/import-webstorm-theme.mjs <원본 폴더>` 가 만든다. 매핑표는 그 스크립트의 `MAPPING` 이다.");
  lines.push("");
  lines.push("출처 표기: `ui:` theme.json 의 ui 키(`*` 는 와일드카드), `pal:` theme.json 팔레트, `sc:` 스킴 colors, `at:이름.필드` 스킴 attributes(`FOREGROUND`, `BACKGROUND`, `EFFECT_COLOR`, `ERROR_STRIPE_COLOR`), `tok:` 같은 테마의 다른 토큰, `a(출처,알파)` 알파를 곱한 파생. `A | B` 는 A 가 없을 때 B.");
  lines.push("");
  lines.push(`덮어쓴 토큰: dark ${count("dark")}개, light ${count("light")}개 (전체 ${tokens.color.tokens.length}개). 값이 Lodestar 기본과 같거나 대응하는 JetBrains 키가 없으면 기본을 쓴다.`);
  lines.push("");
  lines.push("## 눈에 띄는 선택");
  lines.push("");
  lines.push("- 면은 JetBrains 의 두 단계를 따른다. 에디터와 채팅 바탕(`pane-bg`, `aux-bg`, `editor-bg`)은 스킴 TEXT 배경, 사이드바와 상태 줄은 ToolWindow 배경이다. 다크에서 에디터가 도구 창보다 어둡다.");
  lines.push("- light 의 `*.foreground` 는 theme.json 에 없다(부모 IntelliJ Light 에서 상속). 그래서 `fg` 는 `CompletionPopup.foreground`(Gray2), `fg-strong` 은 Gray1(#000000)을 쓴다.");
  lines.push("- `fg-muted` 는 `*.infoForeground`(Gray7)가 아니라 `StatusBar.Widget.foreground` 를 쓴다. 다크에서 Gray7 이 도구 창 바탕 위 대비 3:1 에 못 미치기 때문이다. `fg-subtle` 이 `*.infoForeground` 를 받는다.");
  lines.push("- `syntax-type` 은 스킴에 `DEFAULT_CLASS_NAME` 이 없어 `DEFAULT_IDENTIFIER`(본문색)로 간다. WebStorm 은 타입 이름을 따로 칠하지 않는다.");
  lines.push("- `syntax-tag` 는 다크에서 `HTML_TAG_NAME`(#d5b778). 라이트 스킴에는 태그 색이 없어 `DEFAULT_KEYWORD` 로 간다. `syntax-attribute` 는 `XML_ATTRIBUTE_NAME`, 없으면 `DEFAULT_ATTRIBUTE` 다(다크에서 Default 스키마의 #0000ff 를 물려받는 `DEFAULT_ATTRIBUTE` 는 바탕과 대비가 낮아 `XML_ATTRIBUTE_NAME` 이 먼저다).");
  lines.push("- `syntax-function` 은 `DEFAULT_FUNCTION_DECLARATION` 이다. 함수 호출은 WebStorm 에서 본문색이지만 Lodestar 토큰은 선언과 호출을 가르지 않는다.");
  lines.push("- `diff-del-*` 는 `DIFF_DELETED` 라서 회색이다(JetBrains diff 는 삭제를 회색, 변경을 파랑으로 칠한다).");
  lines.push("- `editor-line-highlight` 는 스킴 `CARET_ROW_COLOR`(채우기 색)인데 Lodestar 에서는 현재 줄의 2px 안쪽 테두리로 쓰인다. 값은 가까운 것을 넣었고 모양은 WebStorm 과 다르다.");
  lines.push("- 대응이 없어 기본을 쓰는 토큰: 괄호 쌍 색(`editor-bracket-1~3`, WebStorm 기본은 끔), 보드(`status-*`, `priority-*`, `label-*`), `pr-icon`, `share-frame-*`, 자동완성 종류 아이콘(`symbol-*`), 미니맵 슬라이더, shadow 토큰.");
  lines.push("");
  lines.push("## 매핑");
  lines.push("");
  lines.push("| 토큰 | JetBrains 출처 | dark | light |");
  lines.push("| --- | --- | --- | --- |");
  for (const name of names) lines.push(`| \`${name}\` | ${sourceOf(name)} | ${cell(name, "dark")} | ${cell(name, "light")} |`);
  lines.push("");
  lines.push("## 대비");
  lines.push("");
  lines.push("WCAG 대비 비율. 본문 글자는 4.5, 보조 글자와 구문 색은 3 을 기준으로 잰 값 중 기준에 못 미치는 쌍만 적었다. Lodestar 열은 같은 쌍의 기본 스타일 값이다.");
  lines.push("");
  lines.push("| 모드 | 글자 | 바탕 | WebStorm | Lodestar | 기준 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  const misses = contrast.rows.filter((r) => r.style === "webstorm" && r.ratio < r.min);
  for (const r of misses) {
    const base = contrast.rows.find((x) => x.style === "lodestar" && x.mode === r.mode && x.fg === r.fg && x.bg === r.bg);
    lines.push(`| ${r.mode} | \`${r.fg}\` | \`${r.bg}\` | ${r.ratio.toFixed(2)} | ${base.ratio.toFixed(2)} | ${r.min} |`);
  }
  if (misses.length === 0) lines.push("| 없음 | | | | | |");
  lines.push("");
  return lines.join("\n");
}

main();
