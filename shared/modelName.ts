// 모델 표시 이름에 버전을 붙인다. CLI 2.1.311 부터 모델 목록의 displayName 이 "Opus" 처럼 버전 없이 와서(사용자 10-29),
// 입력창 칩과 응답 아래 줄에 "Opus 5.5" 대신 "Opus" 만 보였다. 이름에 숫자가 없고 실제 id 에서 같은 계열의 버전을 읽을 수 있을 때만 바꾼다.
export function versionedDisplayName(displayName: string, resolvedModel: string | null): string {
  if (/\d/.test(displayName) || !resolvedModel) return displayName;
  const derived = modelNameFromId(resolvedModel);
  return derived && derived.toLowerCase().startsWith(`${displayName.toLowerCase()} `) ? derived : displayName;
}

// "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5". 모양이 다르면 null.
export function modelNameFromId(id: string): string | null {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!match) return null;
  const family = match[1]![0]!.toUpperCase() + match[1]!.slice(1);
  return match[3] ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
}
