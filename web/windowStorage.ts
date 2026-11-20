import { migrateLegacyStorage, scopedStorage, sweepStaleScopes, windowIdFromSearch, type KeyValueStorage } from "../shared/windows";

// 이 창의 id. Electron 메인이 창마다 ?window=<id> 주소로 연다. 브라우저로 붙은 화면과 빠른 입력창은 id 가 없다.
export const WINDOW_ID: string | null = typeof location === "undefined" ? null : windowIdFromSearch(location.search);

// 창 상태 저장본, 저장 안 한 편집(hot exit), 입력창 초안, 패널 크기는 창마다 따로 쓴다. 창 id 가 있으면 localStorage 이름 앞에 창 범위를 붙인 저장소를 돌려주고(shared/windows.ts),
// 없으면(브라우저 접속) 그냥 localStorage 다. 저장소가 막혀 있으면 null.
let scoped: KeyValueStorage | null | undefined;

export function windowStorage(): KeyValueStorage | null {
  if (scoped !== undefined) return scoped;
  try {
    if (typeof localStorage === "undefined") return (scoped = null);
    if (!WINDOW_ID) return (scoped = localStorage);
    // 창이 하나이던 때의 저장본은 첫 창이 한 번 자기 범위로 가져간다
    migrateLegacyStorage(localStorage, WINDOW_ID);
    return (scoped = scopedStorage(localStorage, WINDOW_ID));
  } catch {
    return (scoped = null);
  }
}

// 메인이 알려 준 살아 있는 창 목록에 없는 창의 저장본(닫힌 창, 비정상 종료로 남은 것)을 지운다.
export function sweepClosedWindows(liveIds: readonly string[]) {
  try {
    if (typeof localStorage !== "undefined") sweepStaleScopes(localStorage, new Set(liveIds));
  } catch {
    // 막힌 저장소
  }
}
