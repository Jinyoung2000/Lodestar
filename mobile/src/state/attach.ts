import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileFileRef } from "@shared/mobile";
import type { ImageRef } from "@shared/protocol";
import { JPEG_QUALITY, MAX_FILE_BYTES, MAX_FILES, MAX_IMAGES, THUMB_EDGE, THUMB_QUALITY, allUploaded, isFileAttachment, resizeTarget, uploadProgress, type Attachment } from "../logic/images";
import { uploadToMac } from "../net/upload";
import { client } from "./app";
import { record, now } from "./perf";

export type PickedAsset = { uri: string; width: number; height: number; fileName?: string | null; releaseSource?: () => void };
export type PickedFile = { uri: string; name: string; size: number | null; mimeType: string | null };

let counter = 0;

async function prepare(asset: PickedAsset) {
  const started = now();
  const target = resizeTarget(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri, target ? { maxWidth: target.width, maxHeight: target.height } : undefined);
  if (target) context.resize(target);
  const rendered = await context.renderAsync();
  const out = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
  const thumbContext = ImageManipulator.manipulate(out.uri, { maxWidth: THUMB_EDGE }).resize({ width: THUMB_EDGE });
  const thumbRendered = await thumbContext.renderAsync();
  const thumb = await thumbRendered.saveAsync({ format: SaveFormat.JPEG, compress: THUMB_QUALITY, base64: true });
  record("image-prepare", Math.round((now() - started) * 10) / 10, `${asset.width}x${asset.height} -> ${out.width}x${out.height}`);
  return { uri: out.uri, thumb: `data:image/jpeg;base64,${thumb.base64 ?? ""}` };
}

export type AttachmentsApi = {
  items: Attachment[];
  addAssets: (assets: PickedAsset[]) => number;
  addFiles: (files: PickedFile[]) => number;
  remove: (key: string) => void;
  clear: () => void;
  restore: (items: Attachment[]) => void;
  refs: () => ImageRef[];
  fileRefs: () => MobileFileRef[];
  progress: number | null;
  ready: boolean;
};

export function useAttachments(): AttachmentsApi {
  const [items, setItems] = useState<Attachment[]>([]);
  const itemsRef = useRef(items);
  const update = useCallback((change: (all: Attachment[]) => Attachment[]) => {
    itemsRef.current = change(itemsRef.current);
    setItems(itemsRef.current);
  }, []);
  const contains = useCallback((key: string) => itemsRef.current.some((a) => a.key === key), []);

  const patch = useCallback((key: string, next: Partial<Attachment>) => {
    update((all) => all.map((a) => (a.key === key ? { ...a, ...next } : a)));
  }, [update]);

  const run = useCallback(
    async (key: string, asset: PickedAsset) => {
      try {
        const prepared = await prepare(asset);
        if (!contains(key)) return;
        patch(key, { status: "uploading", progress: 0, uri: prepared.uri, thumb: prepared.thumb });
        const started = now();
        const blob = await (await fetch(prepared.uri)).blob();
        if (!contains(key)) return;
        const target = client.imageUploadTarget();
        if (!target) throw new Error("Not connected to your Mac");
        const { id } = await uploadToMac(target, blob, asset.fileName || "photo.jpg", "image/jpeg", { onProgress: (progress) => contains(key) && patch(key, { progress }) });
        record("image-upload", Math.round((now() - started) * 10) / 10, `${Math.round(blob.size / 1024)} KB`);
        if (contains(key)) patch(key, { status: "done", progress: 1, id });
      } catch (error) {
        if (contains(key)) patch(key, { status: "error", error: error instanceof Error ? error.message : String(error) });
      } finally {
        asset.releaseSource?.();
      }
    },
    [contains, patch],
  );

  const sendFile = useCallback(
    async (key: string, file: PickedFile) => {
      try {
        if (file.size !== null && file.size > MAX_FILE_BYTES) throw new Error(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        const blob = await (await fetch(file.uri)).blob();
        if (!contains(key)) return;
        if (blob.size > MAX_FILE_BYTES) throw new Error(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        if (blob.size === 0) throw new Error("The file is empty");
        const target = client.imageUploadTarget();
        if (!target) throw new Error("Not connected to your Mac");
        patch(key, { status: "uploading", progress: 0 });
        const mediaType = file.mimeType || "application/octet-stream";
        const uploaded = await uploadToMac(target, blob, file.name, mediaType, { kind: "file", timeoutMs: 10 * 60_000, onProgress: (progress) => contains(key) && patch(key, { progress }) });
        if (contains(key)) patch(key, { status: "done", progress: 1, id: uploaded.id, name: uploaded.name ?? file.name, mediaType });
      } catch (error) {
        if (contains(key)) patch(key, { status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    },
    [contains, patch],
  );

  const addFiles = useCallback(
    (files: PickedFile[]) => {
      const room = MAX_FILES - itemsRef.current.filter((a) => a.status !== "error" && isFileAttachment(a)).length;
      const accepted = files.slice(0, Math.max(0, room));
      if (accepted.length === 0) return 0;
      const created = accepted.map((file) => ({ key: `att-${++counter}`, kind: "file" as const, name: file.name, uri: file.uri, status: "processing" as const, progress: 0 }));
      update((all) => [...all.filter((a) => a.status !== "error"), ...created]);
      created.forEach((a, i) => void sendFile(a.key, accepted[i]));
      return accepted.length;
    },
    [sendFile, update],
  );

  const addAssets = useCallback(
    (assets: PickedAsset[]) => {
      const room = MAX_IMAGES - itemsRef.current.filter((a) => a.status !== "error" && !isFileAttachment(a)).length;
      const accepted = assets.slice(0, Math.max(0, room));
      assets.slice(accepted.length).forEach((asset) => asset.releaseSource?.());
      if (accepted.length === 0) return 0;
      const created = accepted.map((asset) => ({ key: `att-${++counter}`, name: asset.fileName || "photo.jpg", uri: asset.uri, status: "processing" as const, progress: 0 }));
      update((all) => [...all.filter((a) => a.status !== "error"), ...created]);
      created.forEach((a, i) => void run(a.key, accepted[i]));
      return accepted.length;
    },
    [run, update],
  );

  const remove = useCallback((key: string) => {
    update((all) => all.filter((a) => a.key !== key));
  }, [update]);

  const clear = useCallback(() => update(() => []), [update]);

  const restore = useCallback((restored: Attachment[]) => {
    update((all) => [...restored.filter((a) => !all.some((b) => b.key === a.key)), ...all].slice(0, MAX_IMAGES + MAX_FILES));
  }, [update]);

  const refs = useCallback(() => itemsRef.current.flatMap((a) => (a.status === "done" && a.id && !isFileAttachment(a) ? [{ id: a.id, label: a.name, thumb: a.thumb ?? "" }] : [])), []);
  const fileRefs = useCallback(() => itemsRef.current.flatMap((a) => (a.status === "done" && a.id && isFileAttachment(a) ? [{ id: a.id, name: a.name, mediaType: a.mediaType ?? "" }] : [])), []);

  useEffect(() => () => { itemsRef.current = []; }, []);
  return { items, addAssets, addFiles, remove, clear, restore, refs, fileRefs, progress: uploadProgress(items), ready: items.length === 0 || allUploaded(items.filter((a) => a.status !== "error")) };
}

export async function pickFromLibrary(limit: number): Promise<PickedAsset[]> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: Math.max(1, limit), quality: 1, exif: false });
  return result.canceled ? [] : result.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, fileName: a.fileName }));
}

export async function pickFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
  return result.canceled ? [] : result.assets.map((a) => ({ uri: a.uri, name: a.name || "file", size: typeof a.size === "number" ? a.size : null, mimeType: a.mimeType ?? null }));
}

export async function takePhoto(): Promise<PickedAsset[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Allow camera access in Settings to take photos.");
  const result = await ImagePicker.launchCameraAsync({ quality: 1, exif: false });
  return result.canceled ? [] : result.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, fileName: a.fileName }));
}
