import { hint } from "./hint";
import { Codicon } from "./icons";
import { flash } from "./store";
import { S } from "./strings";

// 크게 보기 상자(.aside-lightbox)의 이미지 복사 버튼. 닫기 버튼 왼쪽에 둔다.
// 클립보드는 image/png 만 받으므로 다른 형식은 캔버스로 PNG 로 바꿔 쓴다. ClipboardItem 에 Promise 를 넘겨 누른 순간의 사용자 동작으로 쓰기를 허락받는다.
export function LightboxCopy({ src }: { src: string }) {
  const copy = () => {
    const png = fetch(src)
      .then((res) => res.blob())
      .then((blob) => (blob.type === "image/png" ? blob : toPng(blob)));
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
      () => hint(S.copied, undefined, { check: true }),
      () => flash(S.copyFailed, "error"),
    );
  };
  return (
    <button type="button" className="confirm-close lightbox-copy" title={S.lightboxCopyImage} aria-label={S.lightboxCopyImage} onClick={copy}>
      <Codicon name="copy" />
    </button>
  );
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("png"))), "image/png"));
}
