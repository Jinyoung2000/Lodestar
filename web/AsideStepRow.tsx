import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import type { TimelineItem } from "../shared/protocol";
import { asideSummary, shortUrl, type AsideSummary } from "./asideStep";
import { highlightCodeBlocks } from "./markdownCode";
import { useLanguagesVersion } from "./languages";
import { ChevronDown, Codicon } from "./icons";
import { LightboxCopy } from "./LightboxCopy";
import { rpc } from "./rpc";
import { S } from "./strings";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

// Aside(브라우저 조작 REPL, mcp__aside__repl) 호출 한 줄. 줄에는 제목, 주소, 결과 미리보기가 한 줄로 보이고 이미지는 줄 아래에 썸네일로 바로 보인다.
// 펼치면 코드(구문 색)와 결과 글이 나온다. 결과가 길면 한 번 더 접혀 있다.
// state 는 Timeline 의 StepRow 가 정한 줄 상태(running, queued, denied, done, error). gate 는 승인 대기와 거절.
export function AsideStepRow({ item, state, gate, queued }: { item: ToolItem; state: string; gate: "pending" | "denied" | null; queued: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => asideSummary(item), [item.input, item.output, item.status, item.shots]);
  const failed = summary.state === "error" && !item.cancelled && !gate;
  const title = summary.title || S.asideFallbackTitle;
  return (
    <>
      <details className="step step-aside" data-tool={item.name} data-status={state} data-cancelled={item.cancelled || undefined} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="step-icon">{item.cancelled || gate === "denied" || failed ? <Codicon name="error" size={14} /> : <Codicon name="globe" size={14} />}</span>
          <span className="aside-title" title={title}>{title}</span>
          {summary.url && gate !== "denied" && (
            <span className="aside-url faint" title={summary.url}>{shortUrl(summary.url)}</span>
          )}
          {failed && <span className="minus xs">{S.stepFailed}</span>}
          {gate === "pending" && <span className="faint xs">{S.stepWaiting}</span>}
          {queued && <span className="faint xs">{S.stepQueued}</span>}
          {!gate && !queued && <AsidePreview summary={summary} />}
          <span className="step-chevron">
            <ChevronDown size={12} />
          </span>
        </summary>
        {open && gate !== "denied" && <AsideBody item={item} summary={summary} />}
      </details>
      {gate !== "denied" && summary.images.length > 0 && (
        <div className="aside-shots">
          {summary.images.map((candidates) => (
            <AsideThumb key={candidates[0]} candidates={candidates} />
          ))}
        </div>
      )}
    </>
  );
}

// 접힌 줄에서 제목과 주소 뒤에 흐리게 보이는 짧은 결과. 오류면 오류 첫 줄, 출력이 없으면 "No output".
function AsidePreview({ summary }: { summary: AsideSummary }) {
  if (summary.state === "running" || (summary.state === "ok" && !summary.preview)) return <span className="aside-preview" />;
  if (summary.state === "empty") return <span className="aside-preview faint">{S.asideNoOutput}</span>;
  return <span className="aside-preview faint" title={summary.preview}>{summary.preview}</span>;
}

function AsideBody({ item, summary }: { item: ToolItem; summary: AsideSummary }) {
  const code = typeof item.input.code === "string" ? item.input.code : "";
  return (
    <div className="aside-body">
      {code && <AsideCode code={code} />}
      {summary.text && (summary.long && summary.state !== "error" ? (
        <details className="step aside-fold">
          <summary>
            <span className="step-icon">
              <Codicon name="output" size={14} />
            </span>
            <span className="step-verb">{S.asideOutput(summary.textLines)}</span>
            <span className="step-chevron">
              <ChevronDown size={12} />
            </span>
          </summary>
          <AsideOutput text={summary.text} />
        </details>
      ) : (
        <AsideOutput text={summary.text} />
      ))}
    </div>
  );
}

// 명령 상자(Bash 출력)와 같은 상자와 글꼴
function AsideOutput({ text }: { text: string }) {
  return (
    <div className="step-terminal mono aside-output">
      <pre className="step-terminal-output">{text}</pre>
    </div>
  );
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 응답 속 코드 블록과 같은 구문 색(JS). 언어를 아직 못 읽었으면 색 없이 보이다가 읽으면 다시 그린다.
function AsideCode({ code }: { code: string }) {
  const languagesVersion = useLanguagesVersion();
  const html = useMemo(() => highlightCodeBlocks(`<pre><code class="language-javascript">${escapeHtml(code)}</code></pre>`), [code, languagesVersion]);
  return <div className="markdown aside-code" aria-label={S.asideScript} dangerouslySetInnerHTML={{ __html: html }} />;
}

const imageCache = new Map<string, string | null>();
const IMAGE_CACHE_MAX = 40;

function useAsideImage(candidates: string[]) {
  const key = candidates.join("\n");
  const [src, setSrc] = useState<string | null | undefined>(imageCache.get(key));
  useEffect(() => {
    if (imageCache.has(key)) return;
    let cancelled = false;
    void rpc
      .call("aside.readImage", { paths: candidates })
      .then((image) => (image ? `data:${image.mime};base64,${image.data}` : null))
      .catch(() => null)
      .then((url) => {
        if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value as string);
        imageCache.set(key, url);
        if (!cancelled) setSrc(url);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return src;
}

// 줄 아래 썸네일. 누르면 크게 보인다. 파일을 읽을 수 없으면(지워진 옛 기록) 아무것도 그리지 않는다.
function AsideThumb({ candidates }: { candidates: string[] }) {
  const src = useAsideImage(candidates);
  const [large, setLarge] = useState(false);
  if (!src) return null;
  return (
    <>
      <button type="button" className="aside-thumb" title={S.asideImageOpen} onClick={() => setLarge(true)}>
        <img src={src} alt={S.asideImageAlt} />
      </button>
      <DialogPrimitive.Root open={large} onOpenChange={setLarge}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="confirm-overlay" />
          <DialogPrimitive.Content className="aside-lightbox" aria-describedby={undefined}>
            <DialogPrimitive.Title className="aside-lightbox-title">{S.asideImageAlt}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="confirm-close" aria-label={S.asideImageClose}>
              <Codicon name="close" />
            </DialogPrimitive.Close>
            <LightboxCopy src={src} />
            <img className="aside-lightbox-image" src={src} alt={S.asideImageAlt} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
