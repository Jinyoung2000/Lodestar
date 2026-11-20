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

// INLINEMEDIA: 응답 글에 적힌 이미지와 영상 경로의 미리보기를 글 아래에 붙인다.
// 글 속 경로는 shared/media.ts 의 findMediaPaths 가 글자에서 뽑는다(DOM 을 보지 않는다). 마크다운 HTML 은 토큰이 올 때마다 통째로 바뀌므로 미리보기는 그 바깥의 형제 요소로 두어
// 스트리밍 중에도 같은 경로의 요소가 유지된다(다시 불러오거나 깜박이지 않는다). 스트리밍 중에는 findMediaPaths 가 쓰는 중일 수 있는 경로를 뺀다.
// 메시지가 화면 근처에 오기 전에는 데몬에 묻지도 않는다(긴 타임라인을 열 때 호출이 쏟아지지 않게). 읽을 수 없는 경로는 아무것도 그리지 않는다.
export function InlineMedia({ agentId, text, streaming }: { agentId: string; text: string; streaming: boolean }) {
  const paths = useMemo(() => findMediaPaths(text, { streaming }).slice(0, MAX_MEDIA_CANDIDATES), [text, streaming]);
  const key = paths.join("\n");
  const near = useNearViewport();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (!near.seen || !paths.length) return;
    let stale = false;
    // 스트리밍이 막 끝났으면 쓰는 도중에 없다고 답한 경로를 한 번 더 묻는다.
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

// 파일 하나의 미리보기(이미지 썸네일 + 크게 보기, 또는 영상 재생기). 글 아래 줄과 말풍선의 첨부 칩이 같이 쓴다.
export const MediaPreview = memo(function MediaPreview({ info }: { info: MediaInfo }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const src = new URL(info.url, location.href).href;
  return (
    <figure className="media-item" data-kind={info.kind}>
      {info.kind === "image" ? <ImageThumb src={src} name={info.name} onFailed={() => setFailed(true)} /> : <LazyVideo src={src} name={info.name} onFailed={() => setFailed(true)} />}
      <figcaption className="media-name mono" title={info.raw}>
        {info.name}
      </figcaption>
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

// 화면 근처에 오기 전에는 <video> 를 만들지 않는다(preload="metadata" 도 요청이라 긴 타임라인에서는 영상마다 요청이 나간다). 한 번 만든 뒤에는 스크롤로 벗어나도 그대로 둔다.
function LazyVideo({ src, name, onFailed }: { src: string; name: string; onFailed: () => void }) {
  const near = useNearViewport();
  return (
    <div className="media-video" ref={near.ref}>
      {near.seen && <video controls preload="metadata" src={src} aria-label={MD.videoLabel(name)} onError={onFailed} />}
    </div>
  );
}

// 요소가 화면 위아래 600px 안에 처음 들어온 순간부터 seen 이 true. IntersectionObserver 가 없는 환경(시험)에서는 바로 true.
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
