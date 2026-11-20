// 응답 완료 OS 알림의 본문: 마지막 답의 앞부분. macOS 알림은 본문을 두세 줄에서 자르므로 마크다운 기호를 걷고 한 줄로 이어 붙여 줄인다.
// 남는 글이 없으면(도구만 쓰고 끝난 턴) null 을 돌려 호출자가 본문을 비우게 한다.
export function notificationPreview(markdown: string, max = NOTIFICATION_PREVIEW_MAX): string | null {
  const text = markdown
    // 코드 블록은 내용 대신 통째로 뺀다(알림에서 코드는 읽히지 않는다)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    // 표 구분 줄(|---|:-:|). 한 줄 안에서만 보고 | 자리는 앞보기로 찾는다. \s 로 줄을 넘던 옛 식은 빈 줄이 길게 이어진 답에서 세제곱으로 되짚어 화면이 몇 초씩 멈췄다.
    .replace(/^(?=[ \t:|-]*[ \t:|-]\|)[ \t:|-]+$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export const NOTIFICATION_PREVIEW_MAX = 160;
