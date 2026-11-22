import type { MouseEvent } from "react";
import { splitSuggestions } from "../shared/prDiff";
import { Markdown } from "./Timeline";
import { P } from "./prStrings";

export function PrMarkdown({ text, original, className = "pr-markdown" }: { text: string; original?: string[]; className?: string }) {
  const parts = splitSuggestions(text);
  const openLink = (event: MouseEvent) => {
    if (event.nativeEvent.defaultPrevented) return;
    const link = (event.target as HTMLElement).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    event.preventDefault();
    if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noreferrer");
  };
  return (
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
