import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const tokens = JSON.parse(readFileSync(join(root, "design-system", "tokens.json"), "utf8")).color.tokens;
const dark = (name) => tokens.find((t) => t.name === name).value.dark;

const STAR_LIGHT = dark("accent-text");
const STAR_DARK = dark("accent");
const PLATE_TOP = dark("surface-overlay");
const PLATE_BOTTOM = dark("pane-bg");

function starPath({ up, side, pinch }) {
  const c = 512;
  const top = c - up;
  const bottom = c + up;
  const left = c - side;
  const right = c + side;
  return [
    `M${c} ${top}`,
    `Q${c + pinch} ${c - pinch} ${right} ${c}`,
    `Q${c + pinch} ${c + pinch} ${c} ${bottom}`,
    `Q${c - pinch} ${c + pinch} ${left} ${c}`,
    `Q${c - pinch} ${c - pinch} ${c} ${top}`,
    "Z",
  ].join(" ");
}

function iconSvg(size, { small }) {
  const star = small ? starPath({ up: 342, side: 302, pinch: 52 }) : starPath({ up: 336, side: 292, pinch: 36 });
  const glow = small ? "" : `<circle cx="512" cy="512" r="340" fill="url(#glow)"/>`;
  const rim = small ? "" : `<rect x="101" y="101" width="822" height="822" rx="184" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PLATE_TOP}"/>
      <stop offset="1" stop-color="${PLATE_BOTTOM}"/>
    </linearGradient>
    <linearGradient id="star" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${STAR_LIGHT}"/>
      <stop offset="1" stop-color="${STAR_DARK}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${STAR_DARK}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="${STAR_DARK}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)"/>
  ${rim}
  ${glow}
  <path d="${star}" fill="url(#star)"/>
</svg>
`;
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });

function renderPng(small, size, out, work) {
  const svg = join(work, `${small ? "s" : "f"}-${size}.svg`);
  writeFileSync(svg, iconSvg(size, { small }));
  run("sips", ["-s", "format", "png", svg, "--out", out]);
}

mkdirSync(buildDir, { recursive: true });
writeFileSync(join(buildDir, "icon.svg"), iconSvg(1024, { small: false }));
writeFileSync(join(buildDir, "icon-small.svg"), iconSvg(1024, { small: true }));
mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "public", "favicon.svg"), iconSvg(1024, { small: true }));

const iconset = join(buildDir, "icon.iconset");
const work = join(buildDir, ".render");
rmSync(iconset, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
mkdirSync(work, { recursive: true });

const entries = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
for (const [name, size] of entries) renderPng(size <= 64, size, join(iconset, name), work);
run("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
renderPng(false, 1024, join(buildDir, "icon.png"), work);

if (process.argv.includes("--preview")) {
  const shots = join(root, ".verify", "screens");
  mkdirSync(shots, { recursive: true });
  for (const size of [1024, 128, 32, 16]) renderPng(size <= 64, size, join(shots, `icon-${size}.png`), work);
  for (const size of [16, 32]) {
    run("sips", ["-s", "format", "png", "--resampleWidth", String(size * 16), join(shots, `icon-${size}.png`), "--out", join(shots, `icon-${size}-x16.png`)]);
  }
  renderPng(false, 32, join(shots, "icon-32-full.png"), work);
  renderPng(false, 16, join(shots, "icon-16-full.png"), work);
}

rmSync(work, { recursive: true, force: true });
rmSync(iconset, { recursive: true, force: true });
console.log("icon built:", join(buildDir, "icon.icns"));
