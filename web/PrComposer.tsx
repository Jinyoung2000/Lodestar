import { useRef, useState } from "react";
import { suggestionTemplate } from "../shared/prDiff";
import { PrMarkdown } from "./PrMarkdown";
import { P } from "./prStrings";
import { Button } from "./ui/button";

export type ComposerAction = { label: string; primary?: boolean; run: (body: string) => void | Promise<unknown> };

type Props = {
  placeholder: string;
  initial?: string;
  actions: ComposerAction[];
  onCancel?: () => void;
  // 있으면 "Insert suggestion" 버튼이 이 줄들을 채운 ```suggestion 틀을 넣는다 (diff 줄에 다는 코멘트)
  suggestLines?: string[];
  busy: boolean;
  autoFocus?: boolean;
  allowEmpty?: boolean;
  label: string;
};

// 마크다운 입력창: Write 와 Preview 탭, 제안 틀 삽입, 동작 버튼들. 버튼을 누르기 전에는 아무것도 보내지 않는다.
export function PrComposer({ placeholder, initial = "", actions, onCancel, suggestLines, busy, autoFocus, allowEmpty, label }: Props) {
  const [body, setBody] = useState(initial);
  const [preview, setPreview] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const blocked = busy || (!allowEmpty && body.trim() === "");

  const insertSuggestion = () => {
    const template = suggestionTemplate(suggestLines ?? []);
    const el = area.current;
    const at = el ? el.selectionStart : body.length;
    const before = body.slice(0, at);
    const lead = before === "" || before.endsWith("\n") ? "" : "\n";
    setBody(`${before}${lead}${template}\n${body.slice(at)}`);
    setPreview(false);
    requestAnimationFrame(() => el?.focus());
  };

  return (
    <div className="pr-composer">
      <div className="pr-composer-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!preview} data-active={!preview || undefined} onClick={() => setPreview(false)}>
          {P.write}
        </button>
        <button type="button" role="tab" aria-selected={preview} data-active={preview || undefined} onClick={() => setPreview(true)}>
          {P.preview}
        </button>
        <span className="spacer" />
        {suggestLines && (
          <button type="button" className="pr-composer-suggest" onClick={insertSuggestion} title={P.suggestChange}>
            {P.suggestChange}
          </button>
        )}
      </div>
      {preview ? (
        <div className="pr-composer-preview">{body.trim() ? <PrMarkdown text={body} original={suggestLines} /> : <span className="pr-faint">{P.nothingToPreview}</span>}</div>
      ) : (
        <textarea
          ref={area}
          className="pr-composer-input"
          aria-label={label}
          placeholder={placeholder}
          value={body}
          autoFocus={autoFocus}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
        />
      )}
      <div className="pr-composer-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {P.cancel}
          </Button>
        )}
        <span className="spacer" />
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.primary ? "primary" : "secondary"}
            disabled={blocked}
            onClick={() => {
              void Promise.resolve(action.run(body)).then((ok) => {
                if (ok === true && !initial) setBody("");
              });
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
