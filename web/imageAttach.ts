import { checkImage, imageProblemText } from "../shared/images";
export { clipboardImageFiles, dragHasFiles } from "../shared/images";
import type { ImageRef } from "../shared/protocol";
import { rpc } from "./rpc";
import { hashBytes } from "./attachDedupe";
import { addAttachment, attachmentsOf, findAttachedDuplicate, flash, getState, type Attachment } from "./store";

const THUMB_EDGE = 56;

export async function addImageFiles(paneId: string, files: File[]) {
  let count = attachmentsOf(getState(), paneId).filter((a) => a.image).length;
  for (const file of files) {
    const name = file.name || "image";
    const problem = checkImage(file.type, file.size, count);
    if (problem) {
      flash(imageProblemText(problem, name));
      if (problem === "count") break;
      continue;
    }
    try {
      const data = await readBase64(file);
      const hash = await hashBytes(await file.arrayBuffer());
      const candidate = { workspaceId: null, path: name, startLine: null, endLine: null, text: null, image: { mediaType: file.type, data, thumb: "", name, bytes: file.size, hash } };
      if (findAttachedDuplicate(paneId, candidate)) {
        addAttachment(paneId, candidate);
        continue;
      }
      const thumb = await makeThumb(file);
      addAttachment(paneId, { ...candidate, image: { ...candidate.image, thumb } });
      count++;
    } catch {
      flash(imageProblemText("format", name));
    }
  }
}

export async function uploadImages(attachments: Attachment[]): Promise<ImageRef[]> {
  const refs: ImageRef[] = [];
  for (const a of attachments) {
    if (!a.image) continue;
    const { id } = await rpc.call("images.upload", { mediaType: a.image.mediaType, data: a.image.data, name: a.image.name });
    refs.push({ id, label: a.image.name, thumb: a.image.thumb });
  }
  return refs;
}

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function makeThumb(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

