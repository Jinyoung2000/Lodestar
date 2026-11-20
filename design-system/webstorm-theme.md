# WebStorm 색 스타일 매핑

`settings.themeStyle = "webstorm"` 일 때 `<html data-style="webstorm">` 가 붙고, 아래 토큰만 `tokens.json` 의 `webstorm-dark`, `webstorm-light` 값으로 바뀐다. 밝기(Dark, Light, System)는 그대로 `settings.theme` 이 정한다.

출처: intellij-community master 의 `expUI_dark.theme.json`, `expUI_light.theme.json`(UI 색), `expUI_darkScheme.xml`, `expUI_lightScheme.xml`(에디터 색, 없는 항목은 `DefaultColorSchemesManager.xml` 의 Darcula, Default 스키마). 이 파일은 `scripts/import-webstorm-theme.mjs <원본 폴더>` 가 만든다. 매핑표는 그 스크립트의 `MAPPING` 이다.

출처 표기: `ui:` theme.json 의 ui 키(`*` 는 와일드카드), `pal:` theme.json 팔레트, `sc:` 스킴 colors, `at:이름.필드` 스킴 attributes(`FOREGROUND`, `BACKGROUND`, `EFFECT_COLOR`, `ERROR_STRIPE_COLOR`), `tok:` 같은 테마의 다른 토큰, `a(출처,알파)` 알파를 곱한 파생. `A | B` 는 A 가 없을 때 B.

덮어쓴 토큰: dark 202개, light 180개 (전체 249개). 값이 Lodestar 기본과 같거나 대응하는 JetBrains 키가 없으면 기본을 쓴다.

## 눈에 띄는 선택

- 면은 JetBrains 의 두 단계를 따른다. 에디터와 채팅 바탕(`pane-bg`, `aux-bg`, `editor-bg`)은 스킴 TEXT 배경, 사이드바와 상태 줄은 ToolWindow 배경이다. 다크에서 에디터가 도구 창보다 어둡다.
- light 의 `*.foreground` 는 theme.json 에 없다(부모 IntelliJ Light 에서 상속). 그래서 `fg` 는 `CompletionPopup.foreground`(Gray2), `fg-strong` 은 Gray1(#000000)을 쓴다.
- `fg-muted` 는 `*.infoForeground`(Gray7)가 아니라 `StatusBar.Widget.foreground` 를 쓴다. 다크에서 Gray7 이 도구 창 바탕 위 대비 3:1 에 못 미치기 때문이다. `fg-subtle` 이 `*.infoForeground` 를 받는다.
- `syntax-type` 은 스킴에 `DEFAULT_CLASS_NAME` 이 없어 `DEFAULT_IDENTIFIER`(본문색)로 간다. WebStorm 은 타입 이름을 따로 칠하지 않는다.
- `syntax-tag` 는 다크에서 `HTML_TAG_NAME`(#d5b778). 라이트 스킴에는 태그 색이 없어 `DEFAULT_KEYWORD` 로 간다. `syntax-attribute` 는 `XML_ATTRIBUTE_NAME`, 없으면 `DEFAULT_ATTRIBUTE` 다(다크에서 Default 스키마의 #0000ff 를 물려받는 `DEFAULT_ATTRIBUTE` 는 바탕과 대비가 낮아 `XML_ATTRIBUTE_NAME` 이 먼저다).
- `syntax-function` 은 `DEFAULT_FUNCTION_DECLARATION` 이다. 함수 호출은 WebStorm 에서 본문색이지만 Lodestar 토큰은 선언과 호출을 가르지 않는다.
- `diff-del-*` 는 `DIFF_DELETED` 라서 회색이다(JetBrains diff 는 삭제를 회색, 변경을 파랑으로 칠한다).
- `editor-line-highlight` 는 스킴 `CARET_ROW_COLOR`(채우기 색)인데 Lodestar 에서는 현재 줄의 2px 안쪽 테두리로 쓰인다. 값은 가까운 것을 넣었고 모양은 WebStorm 과 다르다.
- 대응이 없어 기본을 쓰는 토큰: 괄호 쌍 색(`editor-bracket-1~3`, WebStorm 기본은 끔), 보드(`status-*`, `priority-*`, `label-*`), `pr-icon`, `share-frame-*`, 자동완성 종류 아이콘(`symbol-*`), 미니맵 슬라이더, shadow 토큰.

## 매핑

| 토큰 | JetBrains 출처 | dark | light |
| --- | --- | --- | --- |
| `surface-base` | `ui:*.background` | `#2b2d30` | `#f7f8fa` |
| `surface-raised` | dark `pal:Gray3` | `#393b40` | 기본 |
| `chrome-bg` | dark `ui:*.background`, light `ui:ToolWindow.background` | `#2b2d30` | `#f7f8fa` |
| `pane-bg` | dark `at:TEXT.BACKGROUND` | `#1e1f22` | 기본 |
| `aux-bg` | dark `at:TEXT.BACKGROUND` | `#1e1f22` | 기본 |
| `surface-overlay` | dark `ui:*.background` | `#2b2d30` | 기본 |
| `surface-hover` | `ui:*.hoverBackground` | `#393b40` | `#edf3ff` |
| `surface-selected` | `ui:*.selectionInactiveBackground` | `#43454a` | `#dfe1e5` |
| `surface-inset` | `ui:List.Tag.background` | `#393b40` | `#ebecf0` |
| `border-subtle` | `ui:*.separatorColor` | `#393b40` | `#ebecf0` |
| `border` | `ui:Component.borderColor` | `#4e5157` | `#c9ccd6` |
| `fg-strong` | dark `pal:Gray13`, light `pal:Gray1` | `#f0f1f2` | `#000000` |
| `fg` | dark `ui:*.foreground`, light `ui:CompletionPopup.foreground` | `#dfe1e5` | `#27282e` |
| `fg-muted` | `ui:StatusBar.Widget.foreground` | `#9da0a8` | `#6c707e` |
| `activity-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `activity-fg-muted` | `ui:ToolWindow.Button.foreground` | `#9da0a8` | `#5a5d6b` |
| `fg-subtle` | `ui:*.infoForeground` | `#6f737a` | `#818594` |
| `accent` | `ui:Button.default.startBackground` | `#3574f0` | `#3574f0` |
| `focus-border` | `ui:*.focusColor` | `#3574f0` | `#3574f0` |
| `accent-text` | `ui:Link.activeForeground` | `#6b9bfa` | `#315fbd` |
| `running` | `ui:ProgressBar.progressColor` | `#467ff2` | `#3574f0` |
| `success` | `ui:Badge.greenOutlineForeground` | `#5fad65` | `#208a3c` |
| `warning` | `ui:Label.warningForeground` | `#ba9752` | `#a46704` |
| `danger` | `ui:Label.errorForeground` | `#db5c5c` | `#db3b4b` |
| `diff-add-bg` | `at:DIFF_INSERTED.BACKGROUND` | `#294436` | `#bee6be` |
| `diff-add-gutter` | `at:DIFF_INSERTED.ERROR_STRIPE_COLOR` | `#447152` | `#aadeaa` |
| `diff-del-bg` | `at:DIFF_DELETED.BACKGROUND` | `#484a4a` | `#d6d6d6` |
| `diff-del-gutter` | `at:DIFF_DELETED.ERROR_STRIPE_COLOR` | `#656e76` | `#c8c8c8` |
| `syntax-keyword` | `at:DEFAULT_KEYWORD.FOREGROUND` | `#cf8e6d` | `#0033b3` |
| `syntax-keyword-control` | `at:DEFAULT_KEYWORD.FOREGROUND` | `#cf8e6d` | `#0033b3` |
| `syntax-function` | `at:DEFAULT_FUNCTION_DECLARATION.FOREGROUND` | `#56a8f5` | `#00627a` |
| `syntax-type` | `at:DEFAULT_IDENTIFIER.FOREGROUND` | `#bcbec4` | `#000000` |
| `syntax-string` | `at:DEFAULT_STRING.FOREGROUND` | `#6aab73` | `#067d17` |
| `syntax-comment` | `at:DEFAULT_LINE_COMMENT.FOREGROUND` | `#7a7e85` | `#8c8c8c` |
| `syntax-variable` | `at:DEFAULT_IDENTIFIER.FOREGROUND` | `#bcbec4` | `#000000` |
| `syntax-constant` | `at:DEFAULT_CONSTANT.FOREGROUND` | `#c77dbb` | `#871094` |
| `syntax-number` | `at:DEFAULT_NUMBER.FOREGROUND` | `#2aacb8` | `#1750eb` |
| `syntax-regexp` | `at:JS.REGEXP.FOREGROUND` | `#42c3d4` | `#264eff` |
| `syntax-escape` | `at:DEFAULT_VALID_STRING_ESCAPE.FOREGROUND` | `#cf8e6d` | `#0037a6` |
| `syntax-operator` | dark `at:DEFAULT_OPERATION_SIGN.FOREGROUND`, light `at:TEXT.FOREGROUND` | `#bcbec4` | `#080808` |
| `syntax-tag` | dark `at:HTML_TAG_NAME.FOREGROUND`, light `at:DEFAULT_KEYWORD.FOREGROUND` | `#d5b778` | `#0033b3` |
| `syntax-tag-bracket` | dark `at:XML_TAG.FOREGROUND`, light `tok:syntax-tag` | `#d5b778` | `#0033b3` |
| `syntax-attribute` | dark `at:XML_ATTRIBUTE_NAME.FOREGROUND`, light `at:DEFAULT_ATTRIBUTE.FOREGROUND` | `#bcbec4` | `#174ad4` |
| `syntax-selector` | `tok:syntax-tag` | `#d5b778` | `#0033b3` |
| `syntax-value` | dark `at:CSS.COLOR.FOREGROUND`, light `at:DEFAULT_IDENTIFIER.FOREGROUND` | `#56a8f5` | `#000000` |
| `syntax-json-key` | `at:DEFAULT_INSTANCE_FIELD.FOREGROUND` | `#c77dbb` | `#871094` |
| `editor-bg` | dark `at:TEXT.BACKGROUND` | `#1e1f22` | 기본 |
| `editor-fg` | `at:TEXT.FOREGROUND` | `#bcbec4` | `#080808` |
| `editor-line-number` | `sc:LINE_NUMBERS_COLOR` | `#4b5059` | `#aeb3c2` |
| `editor-line-number-active` | `sc:LINE_NUMBER_ON_CARET_ROW_COLOR` | `#a1a3ab` | `#767a8a` |
| `editor-selection` | `sc:SELECTION_BACKGROUND` | `#214283` | `#a6d2ff` |
| `editor-selection-inactive` | `ui:*.selectionInactiveBackground` | `#43454a` | `#dfe1e5` |
| `editor-line-highlight` | `sc:CARET_ROW_COLOR` | `#26282e` | `#f5f8fe` |
| `editor-cursor` | dark `sc:CARET_COLOR` | `#ced0d6` | 기본 |
| `editor-bracket-match-bg` | `at:MATCHED_BRACE_ATTRIBUTES.BACKGROUND` | `#43454a` | `#93d9d9` |
| `editor-bracket-unexpected` | dark `at:UNMATCHED_BRACE_ATTRIBUTES.FOREGROUND` | `#f75464` | 기본 |
| `chat-user-bg` | `a(tok:editor-selection,0.3)` | `#2142834d` | `#a6d2ff4d` |
| `chat-user-bg-hover` | `a(tok:editor-selection,0.6)` | `#21428399` | `#a6d2ff99` |
| `input-bg` | dark `ui:TextField.background` | `#2b2d30` | 기본 |
| `input-border` | `ui:Component.borderColor` | `#4e5157` | `#c9ccd6` |
| `row-selected` | `ui:*.selectionBackground` | `#2e436e` | `#d4e2ff` |
| `row-selected-inactive` | `ui:*.selectionInactiveBackground` | `#43454a` | `#dfe1e5` |
| `row-selected-fg` | dark `ui:*.selectionForeground` | `#dfe1e5` | 기본 |
| `quickinput-bg` | `tok:surface-overlay` | `#2b2d30` | `#ffffff` |
| `quickinput-border` | `ui:Popup.borderColor` | `#43454a` | `#b9bdc9` |
| `quickinput-input-bg` | dark `ui:TextField.background` | `#2b2d30` | 기본 |
| `quickinput-input-border` | `ui:Component.borderColor` | `#4e5157` | `#c9ccd6` |
| `quickinput-placeholder` | `ui:*.infoForeground` | `#6f737a` | `#818594` |
| `quickinput-selected-bg` | `ui:*.selectionBackground` | `#2e436e` | `#d4e2ff` |
| `quickinput-selected-fg` | dark `ui:*.selectionForeground` | `#dfe1e5` | 기본 |
| `quickinput-hover-bg` | `ui:*.hoverBackground` | `#393b40` | `#edf3ff` |
| `quickinput-highlight` | `ui:CompletionPopup.matchForeground` | `#548af7` | `#3574f0` |
| `quickinput-group-border` | `ui:*.separatorColor` | `#393b40` | `#ebecf0` |
| `quickinput-description` | `tok:fg-muted` | `#9da0a8` | `#6c707e` |
| `quickinput-action-hover` | `ui:ActionButton.hoverBackground` | `#ffffff16` | `#00000012` |
| `list-muted-fg` | `tok:fg-muted` | `#9da0a8` | `#6c707e` |
| `inline-code-bg` | dark `a(ui:Code.Inline.backgroundColor,0.15)`, light `a(ui:Code.Inline.backgroundColor,0.07)` | `#b4b8bf26` | `#5a5d6b12` |
| `inline-code-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `diff-count-add` | `tok:success` | `#5fad65` | `#208a3c` |
| `diff-count-del` | `tok:danger` | `#db5c5c` | `#db3b4b` |
| `git-added` | `tok:success` | `#5fad65` | `#208a3c` |
| `git-deleted` | `tok:danger` | `#db5c5c` | `#db3b4b` |
| `unread` | `tok:accent-text` | `#6b9bfa` | `#315fbd` |
| `status-spinner-running` | `tok:accent-text` | `#6b9bfa` | `#315fbd` |
| `status-spinner-waiting` | `tok:warning` | `#ba9752` | `#a46704` |
| `pick-widget-bg` | `ui:Editor.ToolTip.background` | `#393b40` | `#ffffff` |
| `pick-widget-border` | `ui:Editor.ToolTip.border` | `#43454a` | `#c9ccd6` |
| `search-match-bg` | `at:TEXT_SEARCH_RESULT_ATTRIBUTES.BACKGROUND` | `#114957` | `#fcd47e` |
| `scrollbar-slider` | `sc:ScrollBar.Mac.thumbColor` | `#ffffff26` | `#00000033` |
| `scrollbar-slider-hover` | `sc:ScrollBar.Mac.hoverThumbColor` | `#ffffff4d` | `#00000080` |
| `hover-bg` | `sc:DOCUMENTATION_COLOR` | `#2b2d30` | `#ffffff` |
| `hover-fg` | `ui:Editor.ToolTip.foreground` | `#dfe1e5` | `#000000` |
| `hover-border` | `ui:Editor.ToolTip.border` | `#43454a` | `#c9ccd6` |
| `find-widget-bg` | `tok:surface-overlay` | `#2b2d30` | `#ffffff` |
| `find-widget-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `find-widget-border` | `tok:quickinput-border` | `#43454a` | `#b9bdc9` |
| `find-input-bg` | dark `ui:TextField.background` | `#2b2d30` | 기본 |
| `find-input-border` | `ui:Component.borderColor` | `#4e5157` | `#c9ccd6` |
| `find-input-placeholder` | `ui:*.infoForeground` | `#6f737a` | `#818594` |
| `find-option-active-bg` | `ui:SearchOption.selectedBackground` | `#35538f` | `#d4e2ff` |
| `find-option-active-border` | `ui:*.focusColor` | `#3574f0` | `#3574f0` |
| `find-option-active-fg` | dark `ui:*.selectionForeground` | `#dfe1e5` | 기본 |
| `find-option-hover-bg` | `ui:ActionButton.hoverBackground` | `#ffffff16` | `#00000012` |
| `find-button-hover-bg` | `ui:ActionButton.hoverBackground` | `#ffffff16` | `#00000012` |
| `find-disabled-fg` | `ui:*.disabledForeground` | `#5a5d63` | `#a8adbd` |
| `find-error-fg` | `tok:danger` | `#db5c5c` | `#db3b4b` |
| `find-error-bg` | `ui:SearchField.errorBackground` | `#5e3838` | `#fad4d8` |
| `find-error-border` | `ui:Component.errorFocusColor` | `#9c4e4e` | `#db3b4b` |
| `find-match-bg` | `at:SEARCH_RESULT_ATTRIBUTES.BACKGROUND` | `#2d543f` | `#ccccff` |
| `find-match-current-bg` | `at:TEXT_SEARCH_RESULT_ATTRIBUTES.BACKGROUND` | `#114957` | `#fcd47e` |
| `find-ruler` | `at:SEARCH_RESULT_ATTRIBUTES.ERROR_STRIPE_COLOR` | `#42bd77` | `#8e8eb2` |
| `hover-highlight` | `ui:CompletionPopup.matchForeground` | `#548af7` | `#3574f0` |
| `hover-status-bg` | `ui:Editor.ToolTip.selectionBackground` | `#2b2d30` | `#ebecf0` |
| `hover-link` | `ui:Link.activeForeground` | `#6b9bfa` | `#315fbd` |
| `editor-link-active` | `at:CTRL_CLICKABLE.FOREGROUND` | `#548af7` | `#006dcc` |
| `code-block-bg` | `tok:surface-base` | `#2b2d30` | `#f7f8fa` |
| `code-block-border` | `ui:Code.Block.borderColor` | `#393b40` | `#ebecf0` |
| `suggest-selected-bg` | `ui:*.selectionBackground` | `#2e436e` | `#d4e2ff` |
| `suggest-selected-fg` | dark `ui:*.selectionForeground` | `#dfe1e5` | 기본 |
| `editor-error` | `at:ERRORS_ATTRIBUTES.EFFECT_COLOR` | `#fa6675` | `#ff0000` |
| `editor-warning` | dark `at:WARNING_ATTRIBUTES.EFFECT_COLOR`, light `at:WARNING_ATTRIBUTES.ERROR_STRIPE_COLOR` | `#f2c55c` | `#f2bf57` |
| `editor-info` | `at:INFO_ATTRIBUTES.EFFECT_COLOR` | `#857042` | `#cccccc` |
| `editor-indent-guide` | `sc:INDENT_GUIDE` | `#313438` | `#ebecf0` |
| `editor-indent-guide-active` | `sc:SELECTED_INDENT_GUIDE` | `#666870` | `#aeb3c2` |
| `editor-whitespace` | `sc:WHITESPACES` | `#6f737a` | `#adadad` |
| `editor-fold-bg` | `at:FOLDED_TEXT_ATTRIBUTES.BACKGROUND` | `#393b40` | `#e9f5e6` |
| `editor-fold-placeholder` | `at:FOLDED_TEXT_ATTRIBUTES.FOREGROUND` | `#868991` | `#414d41` |
| `editor-fold-control` | `tok:editor-line-number` | `#4b5059` | `#aeb3c2` |
| `editor-cursor-text` | dark `tok:editor-bg` | `#1e1f22` | 기본 |
| `tab-drop-border` | `ui:DragAndDrop.borderColor` | `#3574f0` | `#3574f0` |
| `tab-strip-bg` | `ui:EditorTabs.background` | `#1e1f22` | `#ffffff` |
| `menu-bg` | dark `tok:surface-overlay` | `#2b2d30` | 기본 |
| `menu-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `menu-border` | dark `ui:Menu.borderColor`, light `ui:Menu.borderColor.os.default` | `#43454a` | `#ebecf0` |
| `menu-selection-bg` | `ui:*.selectionBackground` | `#2e436e` | `#d4e2ff` |
| `menu-selection-fg` | `ui:*.selectionForeground` | `#dfe1e5` | `#000000` |
| `menu-separator` | dark `ui:Menu.separatorColor`, light `ui:*.separatorColor` | `#43454a` | `#ebecf0` |
| `tab-strip-border` | dark `ui:EditorTabs.underTabsBorderColor`, light `ui:*.separatorColor` | `#393b40` | `#ebecf0` |
| `tab-active-bg` | dark `ui:EditorTabs.underlinedTabBackground` | `#1e1f22` | 기본 |
| `tab-hover-bg` | `ui:*.hoverBackground` | `#393b40` | `#edf3ff` |
| `tab-hover-bg-unfocused` | `ui:*.hoverBackground` | `#393b40` | `#edf3ff` |
| `tab-active-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `tab-inactive-fg` | `tok:fg-muted` | `#9da0a8` | `#6c707e` |
| `tab-inactive-fg-unfocused` | `a(tok:fg-muted,0.5)` | `#9da0a880` | `#6c707e80` |
| `group-drop-bg` | `ui:ToolWindow.DragAndDrop.areaBackground` | `#366acf4d` | `#a0bdf84d` |
| `input-error-bg` | `ui:SearchField.errorBackground` | `#5e3838` | `#fad4d8` |
| `input-error-border` | `ui:Component.errorFocusColor` | `#9c4e4e` | `#db3b4b` |
| `feedback-widget-bg` | `ui:Editor.ToolTip.background` | `#393b40` | `#ffffff` |
| `feedback-widget-border` | `ui:Editor.ToolTip.border` | `#43454a` | `#c9ccd6` |
| `feedback-glyph-bg` | `ui:*.selectionInactiveBackground` | `#43454a` | `#dfe1e5` |
| `peek-title-bg` | `ui:ToolWindow.Header.inactiveBackground` | `#2b2d30` | `#f7f8fa` |
| `peek-title-fg` | dark `tok:fg-strong` | `#f0f1f2` | 기본 |
| `peek-title-desc` | `tok:fg-muted` | `#9da0a8` | `#6c707e` |
| `peek-result-bg` | dark `tok:surface-overlay` | `#2b2d30` | 기본 |
| `peek-result-line-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `peek-result-file-fg` | `tok:fg-strong` | `#f0f1f2` | `#000000` |
| `peek-result-selection-bg` | `ui:*.selectionBackground` | `#2e436e` | `#d4e2ff` |
| `peek-result-selection-fg` | `ui:*.selectionForeground` | `#dfe1e5` | `#000000` |
| `peek-result-selection-inactive-bg` | `ui:*.selectionInactiveBackground` | `#43454a` | `#dfe1e5` |
| `peek-result-match-bg` | `at:TEXT_SEARCH_RESULT_ATTRIBUTES.BACKGROUND` | `#114957` | `#fcd47e` |
| `peek-editor-bg` | `tok:editor-bg` | `#1e1f22` | `#ffffff` |
| `peek-editor-match-bg` | `at:TEXT_SEARCH_RESULT_ATTRIBUTES.BACKGROUND` | `#114957` | `#fcd47e` |
| `peek-badge-bg` | `ui:Counter.background` | `#868a91` | `#a8adbd` |
| `peek-badge-fg` | `ui:Counter.foreground` | `#000000` | `#ffffff` |
| `statusbar-bg` | dark `ui:*.background`, light `ui:StatusBar.background` | `#2b2d30` | `#f7f8fa` |
| `statusbar-fg` | `ui:StatusBar.Widget.foreground` | `#9da0a8` | `#6c707e` |
| `statusbar-border` | `tok:border-subtle` | `#393b40` | `#ebecf0` |
| `statusbar-item-hover-bg` | dark `ui:ActionButton.hoverBackground`, light `ui:StatusBar.Widget.hoverBackground` | `#ffffff16` | `#ebecf0` |
| `statusbar-item-hover-fg` | dark `ui:StatusBar.Widget.hoverForeground` | `#dfe1e5` | 기본 |
| `statusbar-item-active-bg` | `ui:StatusBar.Widget.pressedBackground` | `#43454a` | `#dfe1e5` |
| `action-widget-bg` | dark `tok:surface-overlay` | `#2b2d30` | 기본 |
| `action-widget-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `action-widget-hover-bg` | `ui:*.hoverBackground` | `#393b40` | `#edf3ff` |
| `action-widget-desc` | `tok:fg-muted` | `#9da0a8` | `#6c707e` |
| `action-widget-disabled` | `ui:*.disabledForeground` | `#5a5d63` | `#a8adbd` |
| `action-widget-link` | `tok:accent-text` | `#6b9bfa` | `#315fbd` |
| `editor-word-highlight` | `at:IDENTIFIER_UNDER_CARET_ATTRIBUTES.BACKGROUND` | `#373b39` | `#edebfc` |
| `editor-word-highlight-strong` | `at:WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES.BACKGROUND` | `#402f33` | `#fce8f4` |
| `editor-word-highlight-text` | `at:IDENTIFIER_UNDER_CARET_ATTRIBUTES.BACKGROUND` | `#373b39` | `#edebfc` |
| `rename-widget-bg` | `tok:surface-overlay` | `#2b2d30` | `#ffffff` |
| `rename-widget-fg` | `tok:fg` | `#dfe1e5` | `#27282e` |
| `rename-widget-border` | `tok:quickinput-border` | `#43454a` | `#b9bdc9` |
| `rename-input-bg` | dark `ui:TextField.background` | `#2b2d30` | 기본 |
| `rename-input-border` | `ui:Component.borderColor` | `#4e5157` | `#c9ccd6` |
| `ruler-error` | `at:ERRORS_ATTRIBUTES.ERROR_STRIPE_COLOR` | `#d64d5b` | `#cf5b56` |
| `ruler-added` | `a(sc:ADDED_LINES_COLOR,0.6)` | `#54915999` | `#7fc78499` |
| `ruler-modified` | `a(sc:MODIFIED_LINES_COLOR,0.6)` | `#375fad99` | `#88adf799` |
| `ruler-deleted` | `a(sc:DELETED_LINES_COLOR,0.6)` | `#868a9199` | `#767a8a99` |
| `ruler-border` | `tok:border-subtle` | `#393b40` | `#ebecf0` |
| `editor-gutter-added` | `sc:ADDED_LINES_COLOR` | `#549159` | `#7fc784` |
| `editor-gutter-modified` | `sc:MODIFIED_LINES_COLOR` | `#375fad` | `#88adf7` |
| `editor-gutter-deleted` | `sc:DELETED_LINES_COLOR` | `#868a91` | `#767a8a` |
| `sticky-hover-bg` | `ui:*.hoverBackground` | `#393b40` | `#edf3ff` |
| `breadcrumb-fg` | `ui:StatusBar.Breadcrumbs.foreground` | `#9da0a8` | `#6c707e` |
| `breadcrumb-fg-focus` | `ui:StatusBar.Breadcrumbs.hoverForeground` | `#dfe1e5` | `#000000` |
| `breadcrumb-picker-bg` | `tok:surface-overlay` | `#2b2d30` | `#ffffff` |
| `breadcrumb-picker-border` | `tok:quickinput-border` | `#43454a` | `#b9bdc9` |
| `breadcrumb-picker-hover` | `ui:*.hoverBackground` | `#393b40` | `#edf3ff` |
| `ruler-word-write` | `at:WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES.ERROR_STRIPE_COLOR` | `#ba6387` | `#f0a8d2` |
| `quick-entry-bg` | `a(tok:surface-overlay,0.93)` | `#2b2d30ed` | `#ffffffed` |
| `quick-entry-border` | `tok:quickinput-border` | `#43454a` | `#b9bdc9` |
| `search-message-fg` | `a(tok:fg,0.65)` | `#dfe1e5a6` | `#27282ea6` |

## 대비

WCAG 대비 비율. 본문 글자는 4.5, 보조 글자와 구문 색은 3 을 기준으로 잰 값 중 기준에 못 미치는 쌍만 적었다. Lodestar 열은 같은 쌍의 기본 스타일 값이다.

| 모드 | 글자 | 바탕 | WebStorm | Lodestar | 기준 |
| --- | --- | --- | --- | --- | --- |
| dark | `fg-subtle` | `surface-base` | 2.90 | 4.81 | 3 |
| dark | `fg-subtle` | `surface-raised` | 2.35 | 4.47 | 3 |
| dark | `fg-subtle` | `chrome-bg` | 2.90 | 4.47 | 3 |
| dark | `fg-subtle` | `surface-overlay` | 2.90 | 3.89 | 3 |
| dark | `editor-line-number` | `editor-bg` | 2.03 | 3.59 | 3 |
| light | `editor-line-number` | `editor-bg` | 2.09 | 4.59 | 3 |
