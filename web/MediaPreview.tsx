import * as DialogPrimitive from "@radix-ui/react-dialog";
import { memo, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { findMediaPaths, MAX_MEDIA_CANDIDATES, MAX_MEDIA_PER_MESSAGE } from "../shared/media";
import type { MediaInfo } from "../shared/protocol";
import { Codicon } from "./icons";
import { LightboxCopy } from "./LightboxCopy";
import { knownMedia, resolveMediaPaths } from "./mediaResolve";
import { MD } from "./mediaStrings";
import { rpc } from "./rpc";
import "./mediaPreview.css";

export function InlineMedia({ agentId, text, streaming }: { agentId: string; text: string; streaming: boolean }) {
  const paths = useMemo(() => findMediaPaths(text, { streaming }).slice(0, MAX_MEDIA_CANDIDATES), [text, streaming]);
  const key = paths.join("\n");
  const near = useNearViewport();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (!near.seen || !paths.length) return;
    let stale = false;
    const ignoreMiss = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    void resolveMediaPaths(agentId, paths, (id, list) => rpc.call("media.resolve", { agentId: id, paths: list }), { ignoreMiss }).then(() => !stale && refresh());
    return () => {
      stale = true;
    };
  }, [agentId, key, near.seen, streaming]);

  const infos = paths.flatMap((path) => knownMedia(agentId, path) ?? []).slice(0, MAX_MEDIA_PER_MESSAGE);
  return (
    <div className="inline-media" ref={near.ref} data-testid="inline-media">
      {infos.map((info) => (
        <MediaPreview key={info.raw} info={info} />
      ))}
    </div>
  );
}

export const MediaPreview = memo(function MediaPreview({ info }: { info: MediaInfo }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const src = new URL(info.url, location.href).href;
  return (
    <figure className="media-item" data-kind={info.kind}>
      {info.kind === "image" ? <ImageThumb src={src} name={info.name} onFailed={() => setFailed(true)} /> : <LazyVideo src={src} name={info.name} onFailed={() => setFailed(true)} />}
      {info.kind !== "image" && (
        <figcaption className="media-name mono" title={info.raw}>
          {info.name}
        </figcaption>
      )}
    </figure>
  );
});

function ImageThumb({ src, name, onFailed }: { src: string; name: string; onFailed: () => void }) {
  const [large, setLarge] = useState(false);
  return (
    <>
      <button type="button" className="media-thumb" title={MD.open} onClick={() => setLarge(true)}>
        <img src={src} alt={name} loading="lazy" decoding="async" onError={onFailed} />
      </button>
      <DialogPrimitive.Root open={large} onOpenChange={setLarge}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="confirm-overlay" />
          <DialogPrimitive.Content className="aside-lightbox" aria-describedby={undefined}>
            <DialogPrimitive.Title className="aside-lightbox-title">{name}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="confirm-close" aria-label={MD.close}>
              <Codicon name="close" />
            </DialogPrimitive.Close>
            <LightboxCopy src={src} />
            <img className="aside-lightbox-image" src={src} alt={name} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

function LazyVideo({ src, name, onFailed }: { src: string; name: string; onFailed: () => void }) {
  const near = useNearViewport();
  return (
    <div className="media-video" ref={near.ref}>
      {near.seen && <video controls preload="metadata" src={src} aria-label={MD.videoLabel(name)} onError={onFailed} />}
    </div>
  );
}

function useNearViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    // lint-tokens: allow 화면 밖 미리 불러올 거리(스타일 값이 아니라 IntersectionObserver 옵션)
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setSeen(true), { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  return { ref, seen };
}
