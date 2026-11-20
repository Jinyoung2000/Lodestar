import { checkImage, imageProblemText } from "../shared/images";
export { clipboardImageFiles, dragHasFiles } from "../shared/images";
import type { ImageRef } from "../shared/protocol";
import { rpc } from "./rpc";
import { hashBytes } from "./attachDedupe";
import { addAttachment, attachmentsOf, findAttachedDuplicate, flash, getState, type Attachment } from "./store";

// fixB: 입력창에 이미지를 붙이는 세 길(붙여넣기, 끌어다 놓기, + 메뉴의 Image...)이 같이 쓰는 조각.
// 이미지는 붙일 때 읽어 입력창 칩(썸네일)으로 두고, 보낼 때 서버(images.upload)에 한 번 올린다. 붙이고 지운 이미지는 서버에 남지 않는다.

const THUMB_EDGE = 56;

// 파일들을 검사해 입력창 칩으로 붙인다. 형식, 크기, 장수가 안 맞는 파일은 이유를 알리고 건너뛴다.
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
      // 내용 해시가 같은 이미지가 이미 붙어 있으면(이름이 달라도) 다시 붙이지 않고 기존 칩을 강조한다. 썸네일도 만들지 않는다.
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

// 보낼 때 입력창 이미지를 서버에 올리고 메시지에 실을 참조(id, 이름, 썸네일)를 돌려준다.
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

// 칩과 말풍선에 쓰는 작은 썸네일(PNG data URL, 긴 변 56). 디코드하지 못하면 거절해서 깨진 파일을 붙이지 않는다.
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

