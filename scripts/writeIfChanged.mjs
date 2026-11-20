// 생성 파일을 내용이 바뀔 때만 쓴다. 같은 내용을 다시 쓰면 수정 시각만 바뀌는데, 자동 업데이트(server/idleUpdate.ts)는 소스 지문(server/srcStamp.ts)을
// 수정 시각으로 재서 빌드(prebuild 의 npm run tokens)가 끝날 때마다 새 소스가 생긴 것으로 보고 빌드를 되풀이했다(2026-11-04 밤, 설치 단계까지 못 감).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function writeIfChanged(path, text) {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}
