import { blendOver, parseColor, toCanvasColor, transparent } from "../web/editorColorModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

check("six digit hex", JSON.stringify(parseColor("#1f1f1f")) === JSON.stringify({ r: 31, g: 31, b: 31, a: 1 }));
check("eight digit hex keeps alpha", Math.abs(parseColor("#d186167e")!.a - 126 / 255) < 1e-9 && parseColor("#d186167e")!.r === 209);
check("three digit hex", parseColor("#fff")!.g === 255);
check("rgba function with comma and with slash", parseColor("rgba(173,214,255,0.15)")!.a === 0.15 && parseColor("rgb(1 2 3 / 50%)")!.a === 0.5);
check("garbage is rejected", parseColor("var(--x)") === null && parseColor("#12") === null);
check("transparent multiplies the alpha like VS Code", Math.abs(transparent(parseColor("#aeafad")!, 0.7).a - 0.7) < 1e-9 && Math.abs(transparent(parseColor("#797979")!, 0.4).a - 0.4) < 1e-9);
check("canvas string", toCanvasColor({ r: 255, g: 18, b: 18, a: 0.7 }) === "rgb(255 18 18 / 0.7)");
check("blend over the background", blendOver({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 }).r === 127.5);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("editor color: all passed");
