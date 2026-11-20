// Q2: 파일 종류 판별과 크기 문구. DOM 이 없어서 단위 시험(test/fileview.test.ts)이 그대로 쓴다.

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

// 지금 배율에서 한 단계 위나 아래. 목록 밖의 배율(맞춤 배율 등)이면 가장 가까운 바깥 단계로 간다.
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0];
}

// 맞춤 보기의 배율: 영역에 들어가게 줄이고(1 을 넘기지 않음) 작은 그림은 실제 크기 그대로.
export function fitScale(image: { width: number; height: number }, area: { width: number; height: number }): number {
  if (!image.width || !image.height || area.width <= 0 || area.height <= 0) return 1;
  return Math.min(1, area.width / image.width, area.height / image.height);
}

// Save As 의 기본 이름: 확장자 앞에 " copy" 를 붙인다(readonly.txt 는 "readonly copy.txt"). 확장자가 없는 이름(Makefile)과 점으로 시작하는 이름(.env)은 끝에, a.test.ts 는 마지막 확장자 앞에 붙는다.
export function copyName(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return `${dir}${name} copy`;
  return `${dir}${name.slice(0, dot)} copy${name.slice(dot)}`;
}
