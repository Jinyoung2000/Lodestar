// daemon.log 줄 앞 ISO 시각 단독 시험(electron/logStamp.ts)
// 실행: npm test
import { LineStamper, stampLine } from "../electron/logStamp";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const times = ["2026-10-16T01:00:00.000Z", "2026-10-16T01:00:01.000Z", "2026-10-16T01:00:02.000Z", "2026-10-16T01:00:03.000Z"];
let tick = 0;
const clock = () => new Date(times[Math.min(tick++, times.length - 1)]);

{
  tick = 0;
  const s = new LineStamper(clock);
  check("one whole line is stamped once", s.feed("[daemon] ready\n") === `${times[0]} [daemon] ready\n`);
  check("several lines in one chunk each get a stamp", new LineStamper(() => new Date(times[0])).feed("a\nb\n") === `${times[0]} a\n${times[0]} b\n`);
}
{
  tick = 0;
  const s = new LineStamper(clock);
  const out = s.feed("[pty] sta") + s.feed("rt pid=1\n[lsp] x");
  check("a line split across chunks is stamped only at its start", out === `${times[0]} [pty] start pid=1\n${times[1]} [lsp] x`, JSON.stringify(out));
  check("the rest of a partial line gets no stamp", s.feed("yz\n") === "yz\n");
}
{
  const s = new LineStamper(() => new Date(times[0]));
  check("empty chunk gives nothing", s.feed("") === "");
  check("a blank line is kept without a stamp", s.feed("a\n\nb\n") === `${times[0]} a\n\n${times[0]} b\n`);
}
{
  const s = new LineStamper(() => new Date(times[0]));
  const bytes = Buffer.from("한글 로그\n", "utf8");
  const out = s.feed(bytes.subarray(0, 4)) + s.feed(bytes.subarray(4));
  check("a multi-byte character split across chunks survives", out === `${times[0]} 한글 로그\n`, JSON.stringify(out));
}
check("stampLine puts the ISO time first and ends with a newline", stampLine("[electron] x", () => new Date(times[2])) === `${times[2]} [electron] x\n`);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
