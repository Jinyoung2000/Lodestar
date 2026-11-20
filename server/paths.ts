import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// 심볼릭 링크를 푼 실제 경로. macOS 의 /tmp 는 /private/tmp 로 이어지는데 git 은 늘 실제 경로를 돌려준다.
// 폴더를 저장하거나 비교할 때 이쪽으로 맞춰 두지 않으면 git 이 준 경로와 저장된 폴더가 문자열로 달라 "작업 폴더 밖" 으로 판정된다.
export function realDir(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// 아직 없는 파일(에이전트가 새로 만들 경로)도 가장 가까운 기존 조상의 실제 경로에 나머지를 붙여서 구한다.
export function realPathLoose(path: string) {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}
