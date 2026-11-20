// 이미지 첨부: 고르거나 찍은 사진을 기기에서 긴 변 2048px, JPEG 0.8 로 줄이고, 작은 미리보기(96px)를 만들고, 데몬에 바이너리로 올린다.
// 줄이기와 올리기는 백그라운드로 돌아 입력창을 막지 않는다. 진행률은 칩에 보이고, 보내기는 올리기가 끝난 뒤에 나간다.
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageRef } from "@shared/protocol";
import { JPEG_QUALITY, MAX_IMAGES, THUMB_EDGE, THUMB_QUALITY, allUploaded, resizeTarget, uploadProgress, type Attachment } from "../logic/images";
import { uploadImage } from "../net/upload";
import { client } from "./app";
import { loadConnection } from "./storage";
import { record, now } from "./perf";

export type PickedAsset = { uri: string; width: number; height: number; fileName?: string | null };

let counter = 0;

async function prepare(asset: PickedAsset) {
  const started = now();
  const target = resizeTarget(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  if (target) context.resize(target);
  const rendered = await context.renderAsync();
  const out = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
  // 말풍선 칩에 쓰는 작은 미리보기(data URL). 서버가 thumb 길이를 제한한다(30KB).
  const thumbContext = ImageManipulator.manipulate(out.uri).resize({ width: THUMB_EDGE });
  const thumbRendered = await thumbContext.renderAsync();
  const thumb = await thumbRendered.saveAsync({ format: SaveFormat.JPEG, compress: THUMB_QUALITY, base64: true });
  record("image-prepare", Math.round((now() - started) * 10) / 10, `${asset.width}x${asset.height} -> ${out.width}x${out.height}`);
  return { uri: out.uri, thumb: `data:image/jpeg;base64,${thumb.base64 ?? ""}` };
}

export type AttachmentsApi = {
  items: Attachment[];
  addAssets: (assets: PickedAsset[]) => void;
  remove: (key: string) => void;
  clear: () => void;
  // 올리기가 모두 끝난 첨부의 참조(서버가 준 id, 이름, 미리보기)
  refs: () => ImageRef[];
  progress: number | null;
  ready: boolean;
};

export function useAttachments(): AttachmentsApi {
  const [items, setItems] = useState<Attachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const cancelled = useRef(new Set<string>());

  const patch = useCallback((key: string, next: Partial<Attachment>) => {
    setItems((all) => all.map((a) => (a.key === key ? { ...a, ...next } : a)));
  }, []);

  const run = useCallback(
    async (key: string, asset: PickedAsset) => {
      try {
        const prepared = await prepare(asset);
        if (cancelled.current.has(key)) return;
        patch(key, { status: "uploading", progress: 0, thumb: prepared.thumb });
        const saved = await loadConnection();
        const host = client.host ?? saved?.hosts[0] ?? null;
        if (!saved || !host) throw new Error("Not connected to your Mac");
        const started = now();
        const blob = await (await fetch(prepared.uri)).blob();
        const { id } = await uploadImage({ host, port: saved.port, token: saved.token }, blob, asset.fileName || "photo.jpg", "image/jpeg", { onProgress: (progress) => !cancelled.current.has(key) && patch(key, { progress }) });
        record("image-upload", Math.round((now() - started) * 10) / 10, `${Math.round(blob.size / 1024)} KB`);
        if (!cancelled.current.has(key)) patch(key, { status: "done", progress: 1, id });
      } catch (error) {
        if (!cancelled.current.has(key)) patch(key, { status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    },
    [patch],
  );

  const addAssets = useCallback(
    (assets: PickedAsset[]) => {
      const room = MAX_IMAGES - itemsRef.current.filter((a) => a.status !== "error").length;
      const accepted = assets.slice(0, Math.max(0, room));
      const created = accepted.map((asset) => ({ key: `att-${++counter}`, name: asset.fileName || "photo.jpg", uri: asset.uri, status: "processing" as const, progress: 0 }));
      setItems((all) => [...all.filter((a) => a.status !== "error"), ...created]);
      created.forEach((a, i) => void run(a.key, accepted[i]));
    },
    [run],
  );

  const remove = useCallback((key: string) => {
    cancelled.current.add(key);
    setItems((all) => all.filter((a) => a.key !== key));
  }, []);

  const clear = useCallback(() => {
    for (const a of itemsRef.current) cancelled.current.add(a.key);
    setItems([]);
  }, []);

  const refs = useCallback(() => itemsRef.current.flatMap((a) => (a.status === "done" && a.id ? [{ id: a.id, label: a.name, thumb: a.thumb ?? "" }] : [])), []);

  useEffect(() => () => void cancelled.current.clear(), []);
  return { items, addAssets, remove, clear, refs, progress: uploadProgress(items), ready: items.length === 0 || allUploaded(items.filter((a) => a.status !== "error")) };
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
