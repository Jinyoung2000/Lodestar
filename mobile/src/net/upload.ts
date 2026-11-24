import { routeAddress, type ConnectionRoute } from "../logic/routes";
import { relayHttp, type RelayEndpoint } from "./relay";

type DirectTarget = ConnectionRoute & { token: string };
type RelayUploadTarget = { relay: RelayEndpoint; token: string };
export type UploadTarget = DirectTarget | RelayUploadTarget;
export type UploadResult = { id: string; name?: string };
export type UploadKind = "image" | "file";

const UPLOAD_PATHS: Record<UploadKind, string> = { image: "/mobile/images", file: "/mobile/files" };
const NAME_HEADERS: Record<UploadKind, string> = { image: "x-image-name", file: "x-file-name" };

export const isRelayTarget = (target: UploadTarget): target is RelayUploadTarget => typeof target.relay === "object";

export function uploadUrl(target: DirectTarget, kind: UploadKind = "image") {
  return `${routeAddress(target)}${UPLOAD_PATHS[kind]}`;
}

export function uploadHeaders(target: { token: string }, name: string, mime: string, kind: UploadKind = "image"): Record<string, string> {
  return { authorization: `Bearer ${target.token}`, "content-type": mime, [NAME_HEADERS[kind]]: encodeURIComponent(name) };
}

function uploadResult(status: number, parsed: Record<string, unknown>, kind: UploadKind = "image"): UploadResult {
  if (status === 200 && typeof parsed.id === "string") return { id: parsed.id, ...(typeof parsed.name === "string" ? { name: parsed.name } : {}) };
  if (status === 404 && kind === "file") throw new Error("Update Lodestar on your Mac to attach files.");
  throw new Error(typeof parsed.error === "string" ? parsed.error : `Upload failed (${status})`);
}

type XhrLike = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  status: number;
  responseText: string;
  timeout: number;
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
};

export type UploadOptions = { kind?: UploadKind; onProgress?: (fraction: number) => void; signal?: AbortSignal; xhr?: () => XhrLike; timeoutMs?: number };

function blobBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Promise.resolve(body);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsArrayBuffer(body as Blob);
  });
}

async function uploadThroughRelay(target: RelayUploadTarget, body: unknown, name: string, mime: string, opts: UploadOptions): Promise<UploadResult> {
  const bytes = await blobBytes(body);
  const kind = opts.kind ?? "image";
  const response = await relayHttp(target.relay, { method: "POST", path: UPLOAD_PATHS[kind], headers: uploadHeaders(target, name, mime, kind), body: bytes }, { onProgress: opts.onProgress, signal: opts.signal, timeoutMs: opts.timeoutMs });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return uploadResult(response.status, parsed, kind);
}

export function uploadToMac(target: UploadTarget, body: unknown, name: string, mime: string, opts: UploadOptions = {}): Promise<UploadResult> {
  if (isRelayTarget(target)) return uploadThroughRelay(target, body, name, mime, opts);
  const make = opts.xhr ?? (typeof XMLHttpRequest !== "undefined" ? () => new XMLHttpRequest() as unknown as XhrLike : null);
  if (!make) return uploadWithFetch(target, body, name, mime, opts);
  return new Promise((resolve, reject) => {
    const xhr = make();
    xhr.open("POST", uploadUrl(target, opts.kind));
    for (const [key, value] of Object.entries(uploadHeaders(target, name, mime, opts.kind))) xhr.setRequestHeader(key, value);
    xhr.timeout = opts.timeoutMs ?? 60_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) opts.onProgress?.(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
      }
      try {
        resolve(uploadResult(xhr.status, parsed, opts.kind));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error("Could not reach your Mac to upload the file"));
    xhr.ontimeout = () => reject(new Error("The upload took too long"));
    opts.signal?.addEventListener("abort", () => {
      xhr.abort();
      reject(new Error("Upload cancelled"));
    });
    xhr.send(body);
  });
}

async function uploadWithFetch(target: DirectTarget, body: unknown, name: string, mime: string, opts: UploadOptions): Promise<UploadResult> {
  const response = await fetch(uploadUrl(target, opts.kind), { method: "POST", headers: uploadHeaders(target, name, mime, opts.kind), body: body as BodyInit, signal: opts.signal });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const result = uploadResult(response.status, parsed, opts.kind);
  opts.onProgress?.(1);
  return result;
}
