import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FV } from "./fileViewStrings";
import { fitScale, formatBytes, stepZoom } from "./fileKind";
import { runFilesAction } from "./filesActions";
import { Codicon } from "./icons";
import { rpc } from "./rpc";
import { Button } from "./ui/button";

// Q2: 이미지(png, jpg, gif, webp, svg)는 미리보기, 그 밖의 바이너리는 안내와 Reveal in Finder 를 에디터 자리에 보인다.
type Source = { url: string; size: number } | { tooLarge: number } | { failed: true } | null;

export function ImagePreview({ workspaceId, path }: { workspaceId: string; path: string }) {
  const [source, setSource] = useState<Source>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  // null 이면 맞춤 보기
  const [zoom, setZoom] = useState<number | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const viewRef = useRef<HTMLDivElement>(null);

  // 다른 프로그램이 그림을 바꾸는 경우(에이전트가 다시 그린 경우 등)를 위해 창이 포커스를 받을 때 다시 읽는다.
  useEffect(() => {
    let disposed = false;
    const load = () =>
      void rpc
        .call("files.readBinary", { workspaceId, path })
        .then((result) => {
          if (disposed) return;
          setSource(result.base64 === null || !result.mime ? { tooLarge: result.size } : { url: `data:${result.mime};base64,${result.base64}`, size: result.size });
        })
        .catch(() => !disposed && setSource({ failed: true }));
    load();
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      window.removeEventListener("focus", load);
    };
  }, [workspaceId, path]);

  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => setArea((before) => (before.width === el.clientWidth && before.height === el.clientHeight ? before : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = natural ? fitScale(natural, area) : 1;
  const scale = zoom ?? fit;
  // Ctrl 이나 ⌘ 를 누른 휠(트랙패드 핀치 포함)로 확대와 축소. 페이지 기본 확대를 막으려면 passive 가 아니어야 한다.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(stepZoom(scaleRef.current, event.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [source]);

  return (
    <div className="file-preview" data-testid="image-preview" aria-label={FV.previewAria}>
      <div className="file-preview-bar">
        <Button size="icon" aria-label={FV.zoomOut} title={FV.zoomOut} disabled={!natural} onClick={() => setZoom(stepZoom(scale, -1))}>
          <Codicon name="zoom-out" />
        </Button>
        <span className="file-preview-zoom" data-testid="image-zoom">
          {FV.zoomLabel(Math.round(scale * 100))}
        </span>
        <Button size="icon" aria-label={FV.zoomIn} title={FV.zoomIn} disabled={!natural} onClick={() => setZoom(stepZoom(scale, 1))}>
          <Codicon name="zoom-in" />
        </Button>
        <Button size="icon" variant={zoom === 1 ? "ghost-on" : "ghost"} aria-label={FV.actualSize} title={FV.actualSize} disabled={!natural} onClick={() => setZoom(1)}>
          <Codicon name="screen-normal" />
        </Button>
        <Button size="icon" variant={zoom === null ? "ghost-on" : "ghost"} aria-label={FV.fitToView} title={FV.fitToView} disabled={!natural} onClick={() => setZoom(null)}>
          <Codicon name="screen-full" />
        </Button>
        <span className="spacer" />
        {natural && source && "url" in source && (
          <span className="file-preview-info faint xs">
            {FV.imageDimensions(natural.width, natural.height)}, {formatBytes(source.size)}
          </span>
        )}
        <Button size="icon" aria-label={FV.reveal} title={FV.reveal} onClick={() => runFilesAction("reveal", { workspaceId, path, kind: "file" })}>
          <Codicon name="folder-opened" />
        </Button>
      </div>
      <div className="file-preview-view" ref={viewRef} data-fit={zoom === null || undefined}>
        {source && "url" in source && (
          <img
            className="file-preview-image"
            src={source.url}
            alt={path.slice(path.lastIndexOf("/") + 1)}
            draggable={false}
            style={natural ? { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) } : undefined}
            onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth || 1, height: e.currentTarget.naturalHeight || 1 })}
            onError={() => setSource({ failed: true })}
          />
        )}
        {source && "tooLarge" in source && <div className="file-preview-note">{FV.imageTooLarge(formatBytes(source.tooLarge))}</div>}
        {source && "failed" in source && <div className="file-preview-note">{FV.imageLoadFailed}</div>}
      </div>
    </div>
  );
}

// 텍스트가 아닌 파일. 에디터에는 싣지 않고 안내와 Finder 로 보기 단추만 둔다.
export function BinaryNotice({ workspaceId, path, size }: { workspaceId: string; path: string; size: number }) {
  return (
    <div className="file-preview file-preview-binary" data-testid="binary-notice" aria-label={FV.previewAria}>
      <Codicon name="file-binary" size={32} className="file-preview-glyph" />
      <div className="file-preview-title">{FV.binaryTitle}</div>
      <div className="file-preview-note">{FV.binaryDetail(formatBytes(size))}</div>
      <Button size="sm" variant="secondary" onClick={() => runFilesAction("reveal", { workspaceId, path, kind: "file" })}>
        {FV.reveal}
      </Button>
    </div>
  );
}
