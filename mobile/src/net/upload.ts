export type UploadTarget = { host: string; port: number; secure?: boolean; token: string };
export type UploadResult = { id: string };

export function uploadUrl(target: UploadTarget) {
  return `${target.secure ? "https" : "http"}://${target.host}:${target.port}/mobile/images`;
}

export function uploadHeaders(target: UploadTarget, name: string, mime: string): Record<string, string> {
  return { authorization: `Bearer ${target.token}`, "content-type": mime, "x-image-name": encodeURIComponent(name) };
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

export type UploadOptions = { onProgress?: (fraction: number) => void; signal?: AbortSignal; xhr?: () => XhrLike; timeoutMs?: number };

export function uploadImage(target: UploadTarget, body: unknown, name: string, mime: string, opts: UploadOptions = {}): Promise<UploadResult> {
  const make = opts.xhr ?? (typeof XMLHttpRequest !== "undefined" ? () => new XMLHttpRequest() as unknown as XhrLike : null);
  if (!make) return uploadWithFetch(target, body, name, mime, opts);
  return new Promise((resolve, reject) => {
    const xhr = make();
    xhr.open("POST", uploadUrl(target));
    for (const [key, value] of Object.entries(uploadHeaders(target, name, mime))) xhr.setRequestHeader(key, value);
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
      if (xhr.status === 200 && typeof parsed.id === "string") resolve({ id: parsed.id });
      else reject(new Error(typeof parsed.error === "string" ? parsed.error : `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Could not reach your Mac to upload the image"));
    xhr.ontimeout = () => reject(new Error("The upload took too long"));
    opts.signal?.addEventListener("abort", () => {
      xhr.abort();
      reject(new Error("Upload cancelled"));
    });
    xhr.send(body);
  });
}

async function uploadWithFetch(target: UploadTarget, body: unknown, name: string, mime: string, opts: UploadOptions): Promise<UploadResult> {
  const response = await fetch(uploadUrl(target), { method: "POST", headers: uploadHeaders(target, name, mime), body: body as BodyInit, signal: opts.signal });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 200 && typeof parsed.id === "string") {
    opts.onProgress?.(1);
    return { id: parsed.id };
  }
  throw new Error(typeof parsed.error === "string" ? parsed.error : `Upload failed (${response.status})`);
}
