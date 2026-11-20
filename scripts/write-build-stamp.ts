// npm run build 의 마지막 단계: 이 빌드가 어떤 소스에서 나왔는지 dist-electron/build-stamp.json 에 적는다.
// 설치된 앱이 스스로 새 소스가 있는지 알아보는 근거다(server/idleUpdate.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { srcStamp } from "../server/srcStamp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 자동 업데이트가 빌드를 시작하기 전에 잰 지문을 넘기면 그것을 쓴다(빌드 중에 소스가 바뀌어도 "그 시점 소스" 로 기록된다).
const stamp = process.env.AGENT_NAV_SRC_STAMP ? { stamp: process.env.AGENT_NAV_SRC_STAMP } : await srcStamp(root);
mkdirSync(join(root, "dist-electron"), { recursive: true });
writeFileSync(join(root, "dist-electron", "build-stamp.json"), JSON.stringify({ src: stamp?.stamp ?? null, builtAt: Date.now() }));
console.log(`build stamp ${stamp?.stamp ?? "(none)"}`);
