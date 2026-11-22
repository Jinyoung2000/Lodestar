import { hint } from "./hint";
import { Codicon } from "./icons";
import { flash } from "./store";
import { S } from "./strings";

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
