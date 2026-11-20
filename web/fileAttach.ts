import { classifyDrop, fileProblemText, oversizeImageNotice } from "../shared/files";
import type { FileRef } from "../shared/protocol";
import { addImageFiles } from "./imageAttach";
import { httpUrl, rpc, TOKEN } from "./rpc";
import { addAttachment, attachmentsOf, flash, getState, removeAttachment, updateAttachment, type Attachment, type FileAttachment } from "./store";

// FILEATTACH: 입력창에 이미지가 아닌 파일을 붙이는 길(끌어다 놓기, 선택창)과 보내기 쪽 조각.
// 모델은 영상 같은 파일을 받지 못하므로 칩으로 두었다가, 보낼 때 절대 경로만 데몬에 넘긴다(server/fileAttach.ts 가 첨부 파일 블록으로 만든다).
// 경로를 얻는 길은 둘이다. 1) Electron preload 의 webUtils.getPathForFile 로 디스크의 원래 경로를 얻으면 복사 없이 바로 칩이 ready 가 된다.
// 2) 경로가 없는 File(브라우저로 붙은 창, 클립보드 바이트, 이 함수가 없는 옛 preload)은 데몬의 POST /attachments 로 올려 데몬이 저장한 경로를 쓴다. 올리는 동안 칩에 진행률이 보인다.

// 업로드 중인 요청. 칩을 지우면 끊는다.
const uploads = new Map<string, XMLHttpRequest>();

// 끌어다 놓은 것에서 파일을 꺼낸다. 폴더는 File 로는 파일처럼 보이므로(크기가 0 이 아니다) 놓는 순간 항목(webkitGetAsEntry)으로 가려 거절하고 알린다.
// items 는 이벤트가 끝나면 비므로 await 전에 동기로 읽는다.
export function addDropped(paneId: string, data: DataTransfer) {
  const files: File[] = [];
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  if (!items.length) files.push(...Array.from(data.files));
  for (const item of items) {
    const file = item.getAsFile();
    if (item.webkitGetAsEntry?.()?.isDirectory) flash(fileProblemText("folder", file?.name ?? "Folder"));
    else if (file) files.push(file);
  }
  return addFiles(paneId, files);
}

// 끌어다 놓거나 고른 파일들을 이미지 칩과 파일 칩으로 나눠 붙인다. 이미지(5MB 이하)는 지금 그대로 이미지 칩이고, 그 밖의 것은 파일 칩이다.
export async function addFiles(paneId: string, files: File[]) {
  const images: File[] = [];
  let count = attachmentsOf(getState(), paneId).filter((a) => a.file).length;
  for (const file of files) {
    const name = file.name || "file";
    const drop = classifyDrop(file.type, file.size, count);
    if (drop.kind === "reject") {
      flash(fileProblemText(drop.problem, name));
      if (drop.problem === "count") break;
      continue;
    }
    if (drop.kind === "image") {
      images.push(file);
      continue;
    }
    if (drop.oversizeImage) flash(oversizeImageNotice(name));
    attachFile(paneId, file, name);
    count++;
  }
  if (images.length) await addImageFiles(paneId, images);
}

function attachFile(paneId: string, file: File, name: string) {
  const path = nativePath(file);
  const info: FileAttachment = { name, bytes: file.size, mediaType: file.type, path, status: path ? "ready" : "uploading", progress: 0, uploadId: null };
  const id = addAttachment(paneId, { workspaceId: null, path: name, startLine: null, endLine: null, text: null, file: info });
  // 경로를 아는 파일이 이미 붙어 있으면 addAttachment 가 기존 칩 id 를 돌려주고 강조한다(업로드할 일이 없다).
  if (!path) upload(paneId, id, file, info);
}

// Finder 에서 놓은 파일의 디스크 경로. 모르면 null(업로드 폴백).
export function nativePath(file: File): string | null {
  try {
    const path = window.agentNavNative?.pathForFile?.(file) ?? "";
    return path.startsWith("/") ? path : null;
  } catch {
    return null;
  }
}

function upload(paneId: string, id: string, file: File, info: FileAttachment) {
  const xhr = new XMLHttpRequest();
  uploads.set(id, xhr);
  const patch = (next: Partial<FileAttachment>) => updateAttachment(paneId, id, { file: { ...info, ...next } });
  const fail = (message: string) => {
    uploads.delete(id);
    patch({ status: "error", error: message });
    flash(`${info.name}: ${message}`, "error");
  };
  xhr.open("POST", httpUrl("/attachments", { name: info.name }));
  xhr.setRequestHeader("x-agent-nav-token", TOKEN);
  let last = 0;
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const progress = event.loaded / event.total;
    // 칩을 다시 그리는 횟수를 줄이려고 1% 이상 바뀔 때만 알린다.
    if (progress - last >= 0.01) {
      last = progress;
      patch({ progress });
    }
  };
  xhr.onload = () => {
    uploads.delete(id);
    let body: { id?: string; path?: string; error?: string } = {};
    try {
      body = JSON.parse(xhr.responseText);
    } catch {
      // 본문을 못 읽으면 아래에서 상태 코드로 실패 처리한다.
    }
    if (xhr.status === 200 && body.id && body.path) patch({ path: body.path, uploadId: body.id, status: "ready", progress: 1 });
    else fail(body.error ?? `Upload failed (${xhr.status})`);
  };
  xhr.onerror = () => fail("Upload failed. Is the daemon running?");
  xhr.send(file);
}

// 파일 칩을 지운다. 올리는 중이면 끊고, 올려 둔 파일이 있으면 데몬에서도 지운다. 보낸 뒤 입력창을 비울 때는 부르지 않는다(보낸 파일은 대화가 가리킨다).
export function removeFileChip(paneId: string, chip: Attachment) {
  uploads.get(chip.id)?.abort();
  uploads.delete(chip.id);
  removeAttachment(paneId, chip.id);
  const uploadId = chip.file?.uploadId;
  if (uploadId) void rpc.call("attachments.discard", { id: uploadId }).catch(() => undefined);
}

// 보낼 수 있는 파일 칩을 FileRef 로. 아직 올리는 중이거나 실패한 칩이 있으면 이유를 돌려주고 보내지 않는다.
export function fileRefsOf(chips: Attachment[]): { refs: FileRef[] } | { blocked: "uploading" | "error" } {
  const refs: FileRef[] = [];
  for (const chip of chips) {
    const file = chip.file;
    if (!file) continue;
    if (file.status === "uploading") return { blocked: "uploading" };
    if (file.status === "error" || !file.path) return { blocked: "error" };
    refs.push({ path: file.path, name: file.name, bytes: file.bytes, mediaType: file.mediaType });
  }
  return { refs };
}
