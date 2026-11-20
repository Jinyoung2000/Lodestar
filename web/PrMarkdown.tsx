import type { MouseEvent } from "react";
import { splitSuggestions } from "../shared/prDiff";
import { Markdown } from "./Timeline";
import { P } from "./prStrings";

// PR 코멘트 본문. ```suggestion 블록은 GitHub 처럼 "Suggested change" 칸(바뀔 줄은 삭제, 제안은 추가)으로 보이고, 링크는 앱 안에서 열지 않고 밖에서 연다.
// original 은 제안이 바꿀 줄(알 수 있을 때만). 없으면 제안 줄만 보인다.
export function PrMarkdown({ text, original, className = "pr-markdown" }: { text: string; original?: string[]; className?: string }) {
  const parts = splitSuggestions(text);
  const openLink = (event: MouseEvent) => {
    // 앱 창의 PR 링크 가로채기(web/prLinks.ts, 캡처 단계)가 이미 처리한 클릭이다
    if (event.nativeEvent.defaultPrevented) return;
    const link = (event.target as HTMLElement).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    event.preventDefault();
    if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noreferrer");
  };
  return (
    // 링크 가로채기는 키보드 동작이 아니다(앵커 자체는 Enter 로 같은 핸들러를 탄다)
    <div className={className} onClick={openLink}>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          part.text.trim() ? <Markdown key={index} className="pr-md" text={part.text} linkify={false} breaks /> : null
        ) : (
          <SuggestionBlock key={index} code={part.code} original={original} />
        ),
      )}
    </div>
  );
}

function SuggestionBlock({ code, original }: { code: string; original?: string[] }) {
  const added = code === "" ? [] : code.split("\n");
  return (
    <div className="pr-suggestion">
      <div className="pr-suggestion-head">{P.suggestedChange}</div>
      {(original ?? []).map((line, index) => (
        <div key={`d${index}`} className="pr-suggestion-line" data-type="del">
          <span className="pr-suggestion-mark">-</span>
          <code>{line}</code>
        </div>
      ))}
      {added.map((line, index) => (
        <div key={`a${index}`} className="pr-suggestion-line" data-type="add">
          <span className="pr-suggestion-mark">+</span>
          <code>{line}</code>
        </div>
      ))}
    </div>
  );
}
