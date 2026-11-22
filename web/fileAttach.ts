import { classifyDrop, fileProblemText, oversizeImageNotice } from "../shared/files";
import type { FileRef } from "../shared/protocol";
import { addImageFiles } from "./imageAttach";
import { httpUrl, rpc, TOKEN } from "./rpc";
import { addAttachment, attachmentsOf, flash, getState, removeAttachment, updateAttachment, type Attachment, type FileAttachment } from "./store";

const uploads = new Map<string, XMLHttpRequest>();

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
  if (!path) upload(paneId, id, file, info);
}

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
    }
    if (xhr.status === 200 && body.id && body.path) patch({ path: body.path, uploadId: body.id, status: "ready", progress: 1 });
    else fail(body.error ?? `Upload failed (${xhr.status})`);
  };
  xhr.onerror = () => fail("Upload failed. Is the daemon running?");
  xhr.send(file);
}

export function removeFileChip(paneId: string, chip: Attachment) {
  uploads.get(chip.id)?.abort();
  uploads.delete(chip.id);
  removeAttachment(paneId, chip.id);
  const uploadId = chip.file?.uploadId;
  if (uploadId) void rpc.call("attachments.discard", { id: uploadId }).catch(() => undefined);
}

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
