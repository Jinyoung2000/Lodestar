// Browser 탭 화면의 순수 계산: 확대 단계, 기기 에뮬레이션 크기, iframe 위치 읽기. DOM 을 건드리지 않아 단위 시험이 그대로 부른다.

export const ZOOM_MIN = -4;
export const ZOOM_MAX = 5;
export const clampZoom = (level: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
// Chromium 의 확대 단계(setZoomLevel)와 같은 식: 한 단계에 1.2 배.
// 설정의 쪽 확대 비율(퍼센트)을 확대 단계로. 100% 는 0 이다.
export const percentToZoom = (percent: number) => Math.round((Math.log(percent / 100) / Math.log(1.2)) * 100) / 100;
export const zoomFactor = (level: number) => Math.round(1.2 ** level * 100) / 100;

export type Emulation = { width: number; height: number; dpr: number; scale: number | "auto"; mobile: boolean; userAgent: string };
export const DEFAULT_EMULATION: Emulation = { width: 0, height: 0, dpr: 0, scale: "auto", mobile: false, userAgent: "" };
export const SCALE_CHOICES: readonly (number | "auto")[] = ["auto", 0.5, 0.75, 1, 1.25, 1.5, 2];

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
export const DEVICE_PRESETS: readonly { name: string; width: number; height: number; dpr: number; mobile: boolean; userAgent: string }[] = [
  { name: "iPhone 15 Pro", width: 393, height: 852, dpr: 3, mobile: true, userAgent: IPHONE_UA },
  { name: "iPhone SE", width: 375, height: 667, dpr: 2, mobile: true, userAgent: IPHONE_UA },
  { name: "Pixel 8", width: 412, height: 915, dpr: 2.625, mobile: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36" },
  { name: "iPad Mini", width: 768, height: 1024, dpr: 2, mobile: true, userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
];

export const MIN_DIMENSION = 1;
export const MAX_DIMENSION = 9999;

// 크기 입력칸의 글. 비었거나 auto 면 0, 숫자면 범위 안일 때만, 그 밖은 null(고치라는 뜻).
export function parseDimension(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (value === "" || value === "auto") return 0;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= MIN_DIMENSION && n <= MAX_DIMENSION ? n : null;
}

export const SASH_ROOM = 16;

// 에뮬레이션 칸의 실제 크기와 배율. available 은 칸을 채울 수 있는 크기다.
export function emulatedFrame(emulation: Emulation, available: { width: number; height: number }) {
  const room = { width: Math.max(0, available.width - SASH_ROOM), height: Math.max(0, available.height - SASH_ROOM) };
  const width = emulation.width || room.width;
  const height = emulation.height || room.height;
  const scale = emulation.scale === "auto" ? (room.width > 0 && room.height > 0 ? Math.min(1, room.width / width, room.height / height) : 1) : emulation.scale;
  return { width, height, scale };
}

export function scaleLabel(scale: number | "auto", autoPercent = 100): string {
  return scale === "auto" ? `Auto (${autoPercent}%)` : `${Math.round(scale * 100)}%`;
}

// 선택창 줄의 설명: "393×852 • mobile"
export function presetDescription(preset: { width: number; height: number; mobile: boolean }): string {
  return `${preset.width}\u00d7${preset.height}${preset.mobile ? " \u2022 mobile" : ""}`;
}

// iframe 안 페이지의 주소와 제목. 같은 출처가 아니면 브라우저가 접근을 막아 예외가 나므로 null 이다.
export function readFrameLocation(frame: { location: { href: string }; document: { title: string } } | null | undefined): { url: string; title: string } | null {
  try {
    if (!frame) return null;
    const url = frame.location.href;
    if (!url || url === "about:blank") return null;
    return { url, title: frame.document.title };
  } catch {
    return null;
  }
}

export const MIN_EMULATION_SIZE = 50;
export function resizedDimension(start: { container: number; scale: number; pane: number }, delta: number): number {
  const px = Math.max(MIN_EMULATION_SIZE, Math.min(start.pane, start.container + delta * 2));
  return Math.max(MIN_EMULATION_SIZE, Math.round(px / Math.max(0.01, start.scale)));
}
