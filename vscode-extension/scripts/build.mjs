import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: "dist/extension.js",
  external: ["vscode", "bufferutil", "utf-8-validate"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
});
