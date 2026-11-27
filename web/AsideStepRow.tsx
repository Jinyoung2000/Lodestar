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

function AsideOutput({ text }: { text: string }) {
  return (
    <div className="step-terminal mono aside-output">
      <pre className="step-terminal-output">{text}</pre>
    </div>
  );
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
