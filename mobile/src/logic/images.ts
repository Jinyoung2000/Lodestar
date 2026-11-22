export const MAX_EDGE = 2048;
export const JPEG_QUALITY = 0.8;
export const THUMB_EDGE = 96;
export const THUMB_QUALITY = 0.5;
export const MAX_IMAGES = 5;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function resizeTarget(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (!(longest > maxEdge) || width <= 0 || height <= 0) return null;
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type AttachmentStatus = "processing" | "uploading" | "done" | "error";

export type Attachment = {
  key: string;
  name: string;
  uri: string;
  status: AttachmentStatus;
  progress: number;
  id?: string;
  thumb?: string;
  error?: string;
};

export function uploadProgress(items: readonly Attachment[]): number | null {
  const busy = items.filter((a) => a.status === "processing" || a.status === "uploading");
  if (busy.length === 0) return null;
  const total = items.filter((a) => a.status !== "error");
  return total.reduce((sum, a) => sum + (a.status === "done" ? 1 : a.status === "uploading" ? a.progress : 0), 0) / total.length;
}

export const allUploaded = (items: readonly Attachment[]) => items.every((a) => a.status === "done");
