import type { Colors } from "../theme/theme";
import { LODESTAR_MERMAID_SCRIPT } from "./mermaidScript.generated";

export const DIAGRAM_FONT = "-apple-system,BlinkMacSystemFont,Roboto,'Noto Sans KR',sans-serif";
const FONT_SIZE = 13;
const LINE_HEIGHT = 18;

export const isDiagramSource = (lang: string, code: string) =>
  /^mermaid$/i.test(lang.trim()) && /^\s*(?:%%[^\n]*\n\s*)*(?:sequenceDiagram|flowchart|graph)\b/i.test(code);

export function diagramStyle(colors: Colors) {
  return [
    `.mm-text{fill:${colors.text};font-family:${DIAGRAM_FONT};font-size:${FONT_SIZE}px}`,
    `.mm-muted{fill:${colors.textMuted}}`,
    ".mm-tag{font-weight:600}",
    `.mm-node{fill:${colors.overlay};stroke:${colors.border};stroke-width:1}`,
    `.mm-note{fill:${colors.userBubble};stroke:${colors.border};stroke-width:1}`,
    `.mm-rect{fill:${colors.selected};opacity:.6}`,
    `.mm-frame{fill:none;stroke:${colors.textSubtle};stroke-width:1}`,
    `.mm-group{fill:none;stroke:${colors.textSubtle};stroke-width:1;stroke-dasharray:4 3}`,
    `.mm-lifeline{stroke:${colors.border};stroke-width:1}`,
    `.mm-line{fill:none;stroke:${colors.textMuted};stroke-width:1}`,
    ".mm-thick{stroke-width:2}",
    ".mm-dashed{stroke-dasharray:4 3}",
    `.mm-head{fill:${colors.textMuted}}`,
    `.mm-head-open{fill:none;stroke:${colors.textMuted};stroke-width:1.5}`,
    `.mm-head-cross{fill:none;stroke:${colors.danger};stroke-width:2}`,
    `.mm-label-bg{fill:${colors.codeBackground}}`,
  ].join("");
}

export const styledDiagram = (svg: string, style: string) => svg.replace(/^<svg([^>]*)>/, `<svg$1 xmlns="http://www.w3.org/2000/svg"><style>${style}</style>`);

const inlineScript = (text: string) => text.replace(/<\/(script)/gi, "<\\/$1");

export function diagramDocument(source: string, style: string) {
  const render = `(function(){var post=function(m){window.ReactNativeWebView.postMessage(JSON.stringify(m))};try{var svg=LodestarMermaid.renderMermaid(document,${JSON.stringify(source)});if(!svg){post({failed:true});return}svg.removeAttribute("width");var plain=svg.outerHTML;var box=svg.viewBox.baseVal;svg.style.width=Math.min(box.width,document.body.clientWidth)+"px";var css=document.createElementNS("http://www.w3.org/2000/svg","style");css.textContent=${JSON.stringify(style)};svg.insertBefore(css,svg.firstChild);document.body.appendChild(svg);post({svg:plain,height:Math.ceil(svg.getBoundingClientRect().height)})}catch(e){post({failed:true})}})();`;
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">",
    `<style>:root{--text-ui-sm:${FONT_SIZE}px;--leading-ui-sm:${LINE_HEIGHT}px;--font-sans:${DIAGRAM_FONT}}html,body{margin:0;background:transparent}body{display:flex;justify-content:center}svg{display:block;max-width:100%;height:auto}</style>`,
    "</head><body>",
    `<script>${inlineScript(LODESTAR_MERMAID_SCRIPT)}</script>`,
    `<script>${inlineScript(render)}</script>`,
    "</body></html>",
  ].join("");
}
