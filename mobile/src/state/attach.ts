import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageRef } from "@shared/protocol";
import { JPEG_QUALITY, MAX_IMAGES, THUMB_EDGE, THUMB_QUALITY, allUploaded, resizeTarget, uploadProgress, type Attachment } from "../logic/images";
import { uploadImage } from "../net/upload";
import { client } from "./app";
import { record, now } from "./perf";

export type PickedAsset = { uri: string; width: number; height: number; fileName?: string | null; releaseSource?: () => void };

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
  remove: (key: string) => void;
  clear: () => void;
  restore: (items: Attachment[]) => void;
  refs: () => ImageRef[];
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
        const { id } = await uploadImage(target, blob, asset.fileName || "photo.jpg", "image/jpeg", { onProgress: (progress) => contains(key) && patch(key, { progress }) });
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

  const addAssets = useCallback(
    (assets: PickedAsset[]) => {
      const room = MAX_IMAGES - itemsRef.current.filter((a) => a.status !== "error").length;
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
    update((all) => [...restored.filter((a) => !all.some((b) => b.key === a.key)), ...all].slice(0, MAX_IMAGES));
  }, [update]);

  const refs = useCallback(() => itemsRef.current.flatMap((a) => (a.status === "done" && a.id ? [{ id: a.id, label: a.name, thumb: a.thumb ?? "" }] : [])), []);

  useEffect(() => () => { itemsRef.current = []; }, []);
  return { items, addAssets, remove, clear, restore, refs, progress: uploadProgress(items), ready: items.length === 0 || allUploaded(items.filter((a) => a.status !== "error")) };
}

export async function pickFromLibrary(limit: number): Promise<PickedAsset[]> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: Math.max(1, limit), quality: 1, exif: false });
  return result.canceled ? [] : result.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, fileName: a.fileName }));
}

export async function takePhoto(): Promise<PickedAsset[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Allow camera access in Settings to take photos.");
  const result = await ImagePicker.launchCameraAsync({ quality: 1, exif: false });
  return result.canceled ? [] : result.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, fileName: a.fileName }));
}
