import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { srcStamp } from "../server/srcStamp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = process.env.AGENT_NAV_SRC_STAMP ? { stamp: process.env.AGENT_NAV_SRC_STAMP } : await srcStamp(root);
mkdirSync(join(root, "dist-electron"), { recursive: true });
writeFileSync(join(root, "dist-electron", "build-stamp.json"), JSON.stringify({ src: stamp?.stamp ?? null, builtAt: Date.now() }));
console.log(`build stamp ${stamp?.stamp ?? "(none)"}`);
