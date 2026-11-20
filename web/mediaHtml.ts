// INLINEMEDIA: 마크다운 이미지 `![](로컬 경로)` 는 HTML 의 <img src="/private/tmp/..."> 가 된다. 브라우저가 그 주소를 데몬 웹 서버에 요청해 깨진 그림 아이콘이 뜨므로
// (프레임마다 HTML 이 바뀌는 스트리밍 중에는 요청도 반복된다) 로컬 파일을 가리키는 <img> 는 대체 글(없으면 파일 이름)로 바꾼다. 그림은 글 아래 미리보기(web/MediaPreview.tsx)가 보인다.
import { localImageTarget } from "../shared/media";

const IMG = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/gi;

export function hideLocalImages(html: string): string {
  if (!html.includes("<img")) return html;
  return html.replace(IMG, (whole, src: string) => {
    if (!localImageTarget(src.replace(/&amp;/g, "&"))) return whole;
    const alt = /\balt="([^"]*)"/i.exec(whole)?.[1];
    const name = src.slice(src.lastIndexOf("/") + 1);
    // 정리(DOMPurify)가 끝난 HTML 에 글로 넣는다. 속성값을 내보낼 때 `<` 를 그대로 두는 엔진(옛 Chromium, WebKit)에서는 alt 의 `<img onerror=...` 가 태그로 살아나므로 꺾쇠를 이스케이프한다.
    const text = (alt || name).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<span class="media-local-image" title="${src.replace(/</g, "&lt;").replace(/>/g, "&gt;")}">${text}</span>`;
  });
}
