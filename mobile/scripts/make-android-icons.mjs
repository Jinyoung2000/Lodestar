// 안드로이드 적응형 아이콘 재료를 레포의 앱 아이콘(build/icon.png)에서 만든다. 결과는 assets/ 에 두고 커밋한다(평소엔 다시 돌릴 일이 없다).
// build/icon.png 는 어두운 판 위의 파란 별이다. 별만 잘라(파란 정도로 알파를 만든다) 전경으로, 판 색은 app.json 의 adaptiveIcon.backgroundColor 로 쓴다.
// 적응형 아이콘은 가운데 66% 원 안만 항상 보인다. 별의 꼭짓점은 중심에서 292px 로 1024 캔버스의 안전 반경(313px) 안이라 크기를 그대로 둔다.
// 쓰는 법: node scripts/make-android-icons.mjs  (pngjs 가 설치돼 있어야 한다: expo 의 하위 의존성으로 이미 깔려 있다)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = PNG.sync.read(readFileSync(join(root, "../build/icon.png")));
const { width, height, data } = src;

const foreground = new PNG({ width, height });
const mono = new PNG({ width, height });
for (let i = 0; i < width * height; i++) {
  const o = i * 4;
  const [r, g, b] = [data[o], data[o + 1], data[o + 2]];
  // 판은 거의 회색(파랑이 빨강보다 조금 높은 은은한 빛), 별은 파랑이 빨강보다 훨씬 높다.
  const strength = Math.max(0, Math.min(1, (b - r - 100) / 30));
  const alpha = Math.round(strength * data[o + 3]);
  foreground.data[o] = r;
  foreground.data[o + 1] = g;
  foreground.data[o + 2] = b;
  foreground.data[o + 3] = alpha;
  mono.data[o] = mono.data[o + 1] = mono.data[o + 2] = 255;
  mono.data[o + 3] = alpha;
}
writeFileSync(join(root, "assets/android-icon-foreground.png"), PNG.sync.write(foreground));
writeFileSync(join(root, "assets/android-icon-monochrome.png"), PNG.sync.write(mono));
console.log("wrote assets/android-icon-{foreground,monochrome}.png");
