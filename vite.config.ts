import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import ts from "typescript";
import { defineConfig, type Plugin } from "vite";

// dev 서버에서도 데몬과 같은 토큰을 페이지에 넣는다.
const injectToken = (): Plugin => ({
  name: "agent-nav-token",
  apply: "serve",
  transformIndexHtml(html) {
    const home = process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav");
    return html.replace("__AGENT_NAV_TOKEN__", readFileSync(join(home, "token"), "utf8").trim());
  },
});

// 피드백 요소 선택용: web/ 의 모든 TSX 에서 HTML 요소(소문자 태그)에 data-source="web/App.tsx:142" 와 data-component="TitleBar" 를 붙인다.
// 개발 빌드뿐 아니라 설치해서 쓰는 프로덕션 빌드에서도 요소의 출처를 알아야 해서 항상 켠다. 끄려면 AGENT_NAV_NO_SOURCE_ATTRS=1.
// 속성은 태그 이름 바로 뒤에 한 줄로 끼워 넣으므로 줄 번호와 소스맵 줄은 그대로다.
const sourceAttrs = (): Plugin => ({
  name: "agent-nav-source-attrs",
  enforce: "pre",
  transform(code, id) {
    if (process.env.AGENT_NAV_NO_SOURCE_ATTRS === "1") return null;
    const file = id.split("?")[0];
    if (!file.endsWith(".tsx") || file.includes("node_modules") || !file.includes("/web/")) return null;
    const rel = relative(process.cwd(), file);
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const inserts: { pos: number; text: string }[] = [];
    const nameOf = (node: ts.Node): string | null => {
      for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text)) return n.name.text;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer) || ts.isCallExpression(n.initializer))) return n.name.text;
      }
      return null;
    };
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text)) {
        const has = node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === "data-source");
        if (!has) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const component = nameOf(node);
          inserts.push({ pos: node.tagName.getEnd(), text: ` data-source="${rel}:${line}"${component ? ` data-component="${component}"` : ""}` });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!inserts.length) return null;
    let out = code;
    for (const { pos, text } of inserts.sort((a, b) => b.pos - a.pos)) out = out.slice(0, pos) + text + out.slice(pos);
    return { code: out, map: null };
  },
});

export default defineConfig({
  plugins: [sourceAttrs(), react(), tailwindcss(), injectToken()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // /attachments: 입력창 파일 업로드 폴백(POST). 데몬의 Host 검사를 통과하도록 Host 를 데몬 주소로 바꿔 보낸다.
    proxy: { "/ws": { target: "ws://127.0.0.1:7788", ws: true }, "/attachments": { target: "http://127.0.0.1:7788", changeOrigin: true } },
  },
});
