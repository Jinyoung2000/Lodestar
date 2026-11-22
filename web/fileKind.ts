
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function isImagePath(path: string | null): boolean {
  if (!path) return false;
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8] as const;

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0];
}

export function fitScale(image: { width: number; height: number }, area: { width: number; height: number }): number {
  if (!image.width || !image.height || area.width <= 0 || area.height <= 0) return 1;
  return Math.min(1, area.width / image.width, area.height / image.height);
}

export function copyName(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return `${dir}${name} copy`;
  return `${dir}${name.slice(0, dot)} copy${name.slice(dot)}`;
}
