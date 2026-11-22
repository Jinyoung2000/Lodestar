import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import ts from "typescript";
import { defineConfig, type Plugin } from "vite";

const injectToken = (): Plugin => ({
  name: "agent-nav-token",
  apply: "serve",
  transformIndexHtml(html) {
    const home = process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav");
    return html.replace("__AGENT_NAV_TOKEN__", readFileSync(join(home, "token"), "utf8").trim());
  },
});

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
    proxy: { "/ws": { target: "ws://127.0.0.1:7788", ws: true }, "/attachments": { target: "http://127.0.0.1:7788", changeOrigin: true } },
  },
});
