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
