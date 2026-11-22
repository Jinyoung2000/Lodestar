import { MINIMAP_GLYPHS } from "../web/editorMinimapGlyphs";
import { backgroundIsLight, glyphIndex, isFullWidthCode, lineAtOffset, lineOffsets, lineRuns, minimapLayout, minimapUsable, renderBlock, renderGlyph, renderLayout, renderMinimapLine, scrollTopFromSliderDelta, xForColumn, yForLine, type ImageLike, type RenderLayoutInput } from "../web/editorMinimapModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const wide = minimapLayout({ outerWidth: 800, outerHeight: 600, pixelRatio: 2, remainingWidth: 730, charWidth: 7.8, verticalScrollbarWidth: 14, renderCharacters: true });
check("minimap width at 800px wide, dpr 2", wide.minimapWidth === 89 && wide.minimapLeft === 697 && wide.canvasInnerWidth === 178, JSON.stringify(wide));
check("dpr 2 draws at scale 2: 4 device pixels per line, 2 per column", wide.minimapScale === 2 && wide.minimapLineHeight === 4 && wide.canvasInnerHeight === 1200 && wide.canvasOuterHeight === 600);
const wide1 = minimapLayout({ outerWidth: 800, outerHeight: 600, pixelRatio: 1, remainingWidth: 730, charWidth: 7.8, verticalScrollbarWidth: 14, renderCharacters: true });
check("dpr 1 draws at scale 1: 2 pixels per line", wide1.minimapScale === 1 && wide1.minimapLineHeight === 2 && wide1.minimapWidth === 89 && wide1.canvasInnerWidth === 89);
check("color blocks are 3 pixels per line", minimapLayout({ outerWidth: 800, outerHeight: 600, pixelRatio: 1, remainingWidth: 730, charWidth: 7.8, verticalScrollbarWidth: 14, renderCharacters: false }).minimapLineHeight === 3);
check("a very wide editor is capped at 120", minimapLayout({ outerWidth: 3000, outerHeight: 600, pixelRatio: 1, remainingWidth: 2930, charWidth: 7.8, verticalScrollbarWidth: 14, renderCharacters: true }).minimapWidth === 120);
const left = (width: number) => {
  const layout = minimapLayout({ outerWidth: width, outerHeight: 600, pixelRatio: 2, remainingWidth: width - 70, charWidth: 7.8, verticalScrollbarWidth: 14, renderCharacters: true });
  return { minimap: layout.minimapWidth, text: width - 70 - layout.minimapWidth - 14 };
};
check("text keeps about 89 percent of the room at 480, 400, 320", left(480).minimap === 52 && left(480).text === 344 && left(400).minimap === 43 && left(320).minimap === 34, JSON.stringify([left(480), left(400), left(320)]));
check("hidden only when nothing but the 8px pad would be left", minimapUsable(wide) && !minimapUsable(minimapLayout({ outerWidth: 100, outerHeight: 600, pixelRatio: 1, remainingWidth: 20, charWidth: 7.8, verticalScrollbarWidth: 14, renderCharacters: true })));

const base: RenderLayoutInput = { pixelRatio: 1, minimapLineHeight: 2, canvasInnerHeight: 600, lineHeight: 20, editorHeight: 600, scrollBeyondLastLine: true, viewportStartLine: 1, viewportEndLine: 30, viewportStartLineTop: 0, lineCount: 50, scrollTop: 0, scrollHeight: 1580 };
const shortTop = renderLayout(base, null);
check("a short file shows every line", shortTop.startLineNumber === 1 && shortTop.endLineNumber === 50 && shortTop.topPaddingLineCount === 0);
check("slider is 30 editor lines at 2px each = 60", shortTop.sliderHeight === 60 && shortTop.sliderNeeded && shortTop.sliderTop === 0);
const shortEnd = renderLayout({ ...base, scrollTop: 980, viewportStartLine: 50, viewportStartLineTop: 980 }, null);
check("scrolled to the end the slider has traveled 96px", Math.abs(shortEnd.sliderTop - 96) < 1e-9, String(shortEnd.sliderTop));
const longFile = renderLayout({ ...base, lineCount: 5000, scrollHeight: 100_580, scrollTop: 40_000, viewportStartLine: 2001, viewportEndLine: 2030, viewportStartLineTop: 40_000 }, null);
check("a long file shows a window of 300 lines around the viewport", longFile.endLineNumber - longFile.startLineNumber + 1 === 300 && longFile.startLineNumber === 1892 && longFile.endLineNumber === 2191, JSON.stringify(longFile));
check("the slider top equals the y of the first visible line", Math.abs(longFile.sliderTop - yForLine(longFile, 2001, 2)) < 1e-9, `${longFile.sliderTop} vs ${yForLine(longFile, 2001, 2)}`);
check("scrolling down keeps the window from moving up", (() => {
  const next = renderLayout({ ...base, lineCount: 5000, scrollHeight: 100_580, scrollTop: 40_020, viewportStartLine: 2002, viewportEndLine: 2031, viewportStartLineTop: 40_020 }, longFile);
  return next.startLineNumber >= longFile.startLineNumber;
})());
check("dragging the slider by its own height range moves the scroll by delta / ratio", scrollTopFromSliderDelta(longFile, 10) === Math.round(40_000 + 10 / longFile.sliderRatio));
check("clicking the minimap maps the y to a line", lineAtOffset(longFile, { canvasInnerHeight: 600, canvasOuterHeight: 600, minimapLineHeight: 2, lineCount: 5000 }, 218) === 2001 && lineAtOffset(longFile, { canvasInnerHeight: 600, canvasOuterHeight: 600, minimapLineHeight: 2, lineCount: 5000 }, 10_000) === 5000);

const black = { r: 0, g: 0, b: 0 };
const white = { r: 255, g: 255, b: 255 };
const blank = (width: number, height: number): ImageLike => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { data, width, height };
};
check("the glyph tables have 96 cells of 2 and 8 shades", MINIMAP_GLYPHS[1].length === 192 && MINIMAP_GLYPHS[2].length === 768);
check("ascii maps to its own cell, outside maps by modulo", glyphIndex(33, 1) === 1 && glyphIndex(126, 1) === 94 && glyphIndex(0xac00, 1) === (0xac00 - 32 + 96) % 96 && glyphIndex(0xac00, 3) === 95);
const dark = blank(4, 4);
renderGlyph(dark, 1, 0, 33, white, 255, black, 255, 1, false, false);
check("a dark background softens the table by 12/15", dark.data[(0 * 4 + 1) * 4] === Math.trunc(81 * 0.8) && dark.data[(1 * 4 + 1) * 4] === Math.trunc(29 * 0.8), `${dark.data[4]} ${dark.data[20]}`);
const light = blank(4, 4);
renderGlyph(light, 1, 0, 33, black, 255, white, 255, 1, true, false);
check("a light background softens by 50/60 and draws toward the text color", light.data[4] === Math.round(255 - 255 * (Math.trunc(81 * (50 / 60)) / 255)), String(light.data[4]));
const oneRow = blank(4, 4);
renderGlyph(oneRow, 1, 0, 33, white, 255, black, 255, 1, false, true);
check("a one pixel line draws only the first row", oneRow.data[(1 * 4 + 1) * 4] === 0 && oneRow.data[4] > 0);
const edge = blank(2, 2);
renderGlyph(edge, 2, 0, 33, white, 255, black, 255, 1, false, false);
check("a glyph outside the image is ignored", edge.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0)));
const block = blank(3, 3);
renderBlock(block, 0, 0, white, 255, black, 255, 1, false);
check("a color block mixes half of the text color", block.data[0] === 127.5 || block.data[0] === 128);

const line = blank(40, 4);
renderMinimapLine(line, { mode: 1, scale: 1, bg: black, bgAlpha: 255, bgIsLight: false, fgAlpha: 255, charWidth: 1, y: 0, tabSize: 4, lineHeight: 2, text: "a b", runs: [{ end: 3, color: white }] });
const pixel = (x: number, y = 0) => line.data[(y * 40 + x) * 4]!;
check("characters start after the 8px pad, spaces only advance", pixel(8) > 0 && pixel(9) === 0 && pixel(10) > 0);
const tabbed = blank(40, 4);
renderMinimapLine(tabbed, { mode: 1, scale: 1, bg: black, bgAlpha: 255, bgIsLight: false, fgAlpha: 255, charWidth: 1, y: 0, tabSize: 4, lineHeight: 2, text: "\tb", runs: [{ end: 2, color: white }] });
check("a tab jumps to the next tab stop", tabbed.data[(0 * 40 + 12) * 4]! > 0 && tabbed.data[(0 * 40 + 8) * 4] === 0);
const clipped = blank(12, 4);
renderMinimapLine(clipped, { mode: 1, scale: 1, bg: black, bgAlpha: 255, bgIsLight: false, fgAlpha: 255, charWidth: 1, y: 0, tabSize: 4, lineHeight: 2, text: "aaaaaaaaaaaaaaaa", runs: [{ end: 16, color: white }] });
check("text stops at the last whole column", [8, 9, 10, 11].every((x) => clipped.data[(0 * 12 + x) * 4]! > 0) && clipped.data.length === 12 * 4 * 4);
const centered = blank(20, 8);
renderMinimapLine(centered, { mode: 1, scale: 1, bg: black, bgAlpha: 255, bgIsLight: false, fgAlpha: 255, charWidth: 1, y: 0, tabSize: 4, lineHeight: 4, text: "a", runs: [{ end: 1, color: white }] });
check("a taller line centers the glyph vertically", centered.data[(0 * 20 + 8) * 4] === 0 && centered.data[(1 * 20 + 8) * 4]! > 0);
check("full width characters take two cells", isFullWidthCode(0xac00) && !isFullWidthCode(0x61) && (() => {
  const wideLine = blank(40, 4);
  renderMinimapLine(wideLine, { mode: 1, scale: 1, bg: black, bgAlpha: 255, bgIsLight: false, fgAlpha: 255, charWidth: 1, y: 0, tabSize: 4, lineHeight: 2, text: "가a", runs: [{ end: 2, color: white }] });
  return wideLine.data[(0 * 40 + 8) * 4]! > 0 && wideLine.data[(0 * 40 + 9) * 4]! > 0 && wideLine.data[(0 * 40 + 10) * 4]! > 0;
})());

check("offsets: tab is tabSize cells, wide char two", JSON.stringify(lineOffsets("ab\tc", 4, 1, 100)) === JSON.stringify([8, 9, 10, 14, 15]) && JSON.stringify(lineOffsets("가a", 4, 1, 100)) === JSON.stringify([8, 10, 11]));
check("offsets stop at the canvas width", JSON.stringify(lineOffsets("abcd", 4, 1, 10)) === JSON.stringify([8, 9, 10]) && xForColumn(lineOffsets("abcd", 4, 1, 10), 5, 1, 10) === 10 && xForColumn([], 1, 1, 10) === 8);

const spans = [{ from: 0, to: 3, cls: "kw" }, { from: 4, to: 7, cls: "str" }];
const cursor = { index: 0 };
check("runs cover the whole line with gaps as default", JSON.stringify(lineRuns(spans, cursor, 0, 7)) === JSON.stringify([{ end: 3, cls: "kw" }, { end: 4, cls: "" }, { end: 7, cls: "str" }]));
check("a later line past every span is one default run", JSON.stringify(lineRuns(spans, cursor, 8, 11)) === JSON.stringify([{ end: 3, cls: "" }]));
check("a span crossing lines is cut at each line", (() => {
  const c = { index: 0 };
  const one = lineRuns([{ from: 2, to: 10, cls: "c" }], c, 0, 5);
  const two = lineRuns([{ from: 2, to: 10, cls: "c" }], c, 6, 12);
  return JSON.stringify(one) === JSON.stringify([{ end: 2, cls: "" }, { end: 5, cls: "c" }]) && JSON.stringify(two) === JSON.stringify([{ end: 4, cls: "c" }, { end: 6, cls: "" }]);
})());
check("an empty line has one empty run", lineRuns([], { index: 0 }, 5, 5).length === 1);
check("background lightness", !backgroundIsLight({ r: 31, g: 31, b: 31 }) && backgroundIsLight({ r: 255, g: 255, b: 255 }));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("editor minimap: all passed");
