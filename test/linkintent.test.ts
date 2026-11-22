import { linkActions, simulatorUrlOk, webviewUrl, type LinkAction } from "../shared/linkIntent";
import { linkRows, needsSimulator } from "../web/linkRows";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const kinds = (input: string) => linkActions(input).map((a) => a.kind);
const first = (input: string): LinkAction | undefined => linkActions(input)[0];

check("https 는 Browser 한 줄", same(linkActions("https://example.com/a"), [{ kind: "browser", url: "https://example.com/a" }]));
check("http 도 Browser 한 줄", same(kinds("http://example.com"), ["browser"]));
check("scheme 은 대소문자 무시하고 소문자로, 경로 대소문자는 그대로", same(first("HTTPS://Example.com/Path/CaseKept"), { kind: "browser", url: "https://example.com/Path/CaseKept" }));
check("앞뒤 공백은 잘라 낸다", same(first("  \thttps://example.com/x \n"), { kind: "browser", url: "https://example.com/x" }));
check("쿼리의 한글은 percent-encoding", first("https://example.com/s?q=한글")?.url === "https://example.com/s?q=%ED%95%9C%EA%B8%80");
check("이미 인코딩된 쿼리는 다시 인코딩하지 않는다", first("https://example.com/s?q=a%20b&r=%2F")?.url === "https://example.com/s?q=a%20b&r=%2F");
check("호스트 없는 https:// 는 링크가 아니다", same(linkActions("https://"), []));

check("karrot:// 는 Simulator 한 줄", same(linkActions("karrot://home"), [{ kind: "simulator", url: "karrot://home" }]));
check("karrot.alpha:// 홈", same(linkActions("karrot.alpha://"), [{ kind: "simulator", url: "karrot.alpha://" }]));
check("scheme 대소문자: KARROT.Alpha:// 는 소문자로, 나머지는 그대로", same(first("KARROT.Alpha://MiniKarrot/Router?x=Y"), { kind: "simulator", url: "karrot.alpha://MiniKarrot/Router?x=Y" }));
check("karrot 주소의 공백 앞뒤는 잘라 낸다", first("  karrot://home  ")?.url === "karrot://home");
check("허용 밖 scheme 은 링크가 아니다", same(linkActions("javascript://alert(1)"), []) && same(linkActions("file:///etc/passwd"), []) && same(linkActions("ftp://example.com"), []) && same(linkActions("tel://123"), []) && same(linkActions("karrotx://a"), []) && same(linkActions("mykarrot://a"), []));
check("// 없는 karrot: 는 링크가 아니다", same(linkActions("karrot:home"), []));

const wv = (remote: string) => `karrot.alpha://minikarrot/router?remote=${encodeURIComponent(remote)}&navbar=false&scrollable=false`;
check("localhost:포트 는 Browser 와 Simulator Webview 두 줄", same(linkActions("localhost:3000/me"), [
  { kind: "browser", url: "http://localhost:3000/me" },
  { kind: "simulatorWebview", url: wv("http://localhost:3000/me"), remote: "http://localhost:3000/me" },
]));
check("127.0.0.1:포트 도 두 줄", same(kinds("127.0.0.1:5173"), ["browser", "simulatorWebview"]) && first("127.0.0.1:5173")?.url === "http://127.0.0.1:5173/");
check("http:// 를 붙인 localhost 도 두 줄", same(kinds("http://localhost:3000"), ["browser", "simulatorWebview"]));
check("https://localhost:포트 도 두 줄, remote 는 https 그대로", linkActions("https://localhost:8443/x")[1]?.url === wv("https://localhost:8443/x"));
check("LOCALHOST:3000 은 대소문자 무시", same(kinds("LOCALHOST:3000"), ["browser", "simulatorWebview"]) && first("LOCALHOST:3000")?.url === "http://localhost:3000/");
check("[::1]:포트", same(kinds("[::1]:3000/x"), ["browser", "simulatorWebview"]));
check("localhost 쿼리와 해시", same(first("localhost:3000/a?x=1&y=한글#top")?.url, "http://localhost:3000/a?x=1&y=%ED%95%9C%EA%B8%80#top"));
check("포트 뒤에 바로 ? 와 # 도 허용", same(kinds("localhost:3000?x=1"), ["browser", "simulatorWebview"]) && same(kinds("localhost:3000#h"), ["browser", "simulatorWebview"]));
check("포트 없는 localhost 는 심볼 이름일 수 있어 링크가 아니다", same(linkActions("localhost"), []) && same(linkActions("localhost/foo"), []) && same(linkActions("127.0.0.1"), []));
check("포트 범위 밖은 링크가 아니다", same(linkActions("localhost:70000"), []) && same(linkActions("localhost:123456"), []));
check("localhost:abc 는 링크가 아니다", same(linkActions("localhost:abc"), []));
check("localhost 가 아닌 호스트의 포트만 있는 글은 링크가 아니다", same(linkActions("example.com:3000"), []) && same(linkActions("foo:3000"), []));
check("http://example.com 은 Webview 줄이 없다", same(kinds("http://example.com:3000"), ["browser"]));
check("localhost 를 닮은 호스트는 Webview 줄이 없다", same(kinds("http://localhost.evil.com:3000/"), ["browser"]) && same(kinds("http://notlocalhost:3000/"), ["browser"]));

check("webviewUrl: remote 전체를 percent-encoding", webviewUrl("http://localhost:3000/me?a=1&b=한글#x") === "karrot.alpha://minikarrot/router?remote=http%3A%2F%2Flocalhost%3A3000%2Fme%3Fa%3D1%26b%3D%ED%95%9C%EA%B8%80%23x&navbar=false&scrollable=false");
check("webviewUrl: 뒤따르는 파라미터는 remote 안으로 들어가지 않는다", webviewUrl("http://localhost:3000/?navbar=true").endsWith("&navbar=false&scrollable=false") && webviewUrl("http://localhost:3000/?navbar=true").includes("%3Fnavbar%3Dtrue"));

for (const text of ["", "   ", "useState", "MyClass.method", "Foo::bar", "https", "http:", "http:/x", "https:/example.com", "example.com", "www.example.com", "a b", "https://a b.com", "karrot://a b", "foo://bar", "localhost 3000", "localhost:3000 x", "한글심볼", "//example.com", "https://x\u0000y", "$(open -a Calculator)", "karrot://a;rm -rf"]) {
  check(`링크 아님: ${JSON.stringify(text)}`, same(linkActions(text), []));
}
check("4096자를 넘는 주소는 링크가 아니다", same(linkActions(`https://example.com/${"a".repeat(5000)}`), []));

check("simulatorUrlOk: 허용 scheme 만", simulatorUrlOk("karrot://home") && simulatorUrlOk("karrot.alpha://") && simulatorUrlOk("KARROT.ALPHA://x"));
check("simulatorUrlOk: 그 밖은 거절", !simulatorUrlOk("https://example.com") && !simulatorUrlOk("file:///etc/passwd") && !simulatorUrlOk("") && !simulatorUrlOk(" karrot://x") && !simulatorUrlOk("karrot://x y") && !simulatorUrlOk("-karrot://x") && !simulatorUrlOk(undefined) && !simulatorUrlOk(7) && !simulatorUrlOk("karrot://x\n--flag"));

const sim = (names: string[]) => ({ status: "ready" as const, devices: names.map((name, i) => ({ udid: `0000000${i}-0000-0000-0000-000000000000`, name })) });
const title = (rows: { title: string }[]) => rows.map((r) => r.title);
check("needsSimulator: karrot 과 localhost 는 true, https 는 false", needsSimulator(linkActions("karrot://home")) && needsSimulator(linkActions("localhost:3000")) && !needsSimulator(linkActions("https://example.com")) && !needsSimulator([]));
check("https: Browser 줄 하나, 기기 정보와 무관", same(title(linkRows(linkActions("https://example.com"), null)), ["Open in Browser"]) && linkRows(linkActions("https://example.com"), null)[0].run?.kind === "browser");
check("karrot 이고 기기 하나: Open in Simulator (iPhone 17)", same(title(linkRows(linkActions("karrot.alpha://"), sim(["iPhone 17"]))), ["Open in Simulator (iPhone 17)"]));
check("기기 둘: 기기마다 한 줄, 각자 udid", same(linkRows(linkActions("karrot://home"), sim(["iPhone 17", "iPad Pro"])).map((r) => r.run && "udid" in r.run ? r.run.udid : null), ["00000000-0000-0000-0000-000000000000", "00000001-0000-0000-0000-000000000000"]));
check("켜진 기기 없음: 눌리지 않는 줄과 안내", same(linkRows(linkActions("karrot://home"), sim([])).map((r) => [r.title, r.detail, r.run]), [["Open in Simulator", "No booted simulator", null]]));
check("기기 목록을 읽는 중: 눌리지 않는 줄", linkRows(linkActions("karrot://home"), { status: "loading" })[0].run === null && linkRows(linkActions("karrot://home"), null)[0].run === null);
check("기기 목록 읽기 실패: 이유를 보인다", linkRows(linkActions("karrot://home"), { status: "error", message: "boom" })[0].detail === "Could not list simulators: boom");
check("localhost 기기 하나: Browser 와 Webview 순서", same(title(linkRows(linkActions("localhost:3000/me"), sim(["iPhone 17"]))), ["Open in Browser", "Open in Simulator Webview (iPhone 17)"]));
const webviewRow = linkRows(linkActions("localhost:3000/me"), sim(["iPhone 17"]))[1];
check("Webview 줄은 감싼 주소를 열고, 줄 설명은 원래 주소", webviewRow.run?.kind === "simulator" && webviewRow.run.url === wv("http://localhost:3000/me") && webviewRow.detail === "http://localhost:3000/me");
check("localhost 이고 켜진 기기 없음: Browser 는 눌리고 Webview 는 안 눌린다", same(linkRows(linkActions("localhost:3000"), sim([])).map((r) => [r.title, r.run === null]), [["Open in Browser", false], ["Open in Simulator Webview", true]]));
check("링크가 아니면 줄 없음", same(linkRows(linkActions("useState"), null), []));
check("줄 key 는 서로 다르다", (() => { const rows = linkRows(linkActions("localhost:3000"), sim(["A", "B"])); return new Set(rows.map((r) => r.key)).size === rows.length; })());

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
