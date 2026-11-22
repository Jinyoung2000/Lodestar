import type { PrDetail } from "../shared/prTypes";
import { anchorKey, parsePrUrl, prRefOfUrl, resolveFocus } from "../shared/prUrl";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const base = "https://github.com/example-org/app/pull/8392";
const link = (url: string) => parsePrUrl(url);

check("기본 주소는 Overview", same(link(base), { repo: "example-org/app", number: 8392, tab: "overview", anchor: null }));
check("끝의 슬래시", link(`${base}/`)?.tab === "overview");
check("/files 는 Files 탭", link(`${base}/files`)?.tab === "files");
check("/changes 도 Files 탭", link(`${base}/changes`)?.tab === "files");
check("/commits 는 Commits 탭", link(`${base}/commits`)?.tab === "commits");
check("/commits/<sha> 도 Commits 탭", link(`${base}/commits/abc1234`)?.tab === "commits");
check("/files/<sha> 는 Files 탭", link(`${base}/files/abc1234`)?.tab === "files");
check("/checks 는 Overview 의 체크 위치", same(link(`${base}/checks`), { repo: "example-org/app", number: 8392, tab: "overview", anchor: { kind: "checks" } }));
check("/checks?check_run_id=1 의 쿼리는 무시", link(`${base}/checks?check_run_id=1`)?.anchor?.kind === "checks");
check("알 수 없는 뒷부분은 Overview", link(`${base}/conflicts`)?.tab === "overview");
check("쿼리(?diff=split&w=1)는 무시", same(link(`${base}/files?diff=split&w=1`), { repo: "example-org/app", number: 8392, tab: "files", anchor: null }));
check("대소문자 섞인 경로", link("https://github.com/example-org/app/pull/8392/FILES")?.tab === "files");

check("#discussion_r", same(link(`${base}#discussion_r123456`)?.anchor, { kind: "comment", id: "123456" }));
check("/files#r (Files 탭 앵커 표기)", same(link(`${base}/files#r123456`), { repo: "example-org/app", number: 8392, tab: "files", anchor: { kind: "comment", id: "123456" } }));
check("#issuecomment-", same(link(`${base}#issuecomment-987`)?.anchor, { kind: "comment", id: "987" }));
check("#pullrequestreview-", same(link(`${base}#pullrequestreview-55`)?.anchor, { kind: "review", id: "55" }));
check("쿼리와 앵커가 같이 있어도 앵커를 읽는다", same(link(`${base}/files?diff=split#discussion_r9`)?.anchor, { kind: "comment", id: "9" }));
check("모르는 해시(#diff-해시)는 앵커 없음", link(`${base}/files#diff-0123abc`)?.anchor === null);
check("번호가 아닌 앵커는 앵커 없음", link(`${base}#discussion_rabc`)?.anchor === null);
check("/checks 가 해시보다 우선", link(`${base}/checks#issuecomment-1`)?.anchor?.kind === "checks");

check("issues 주소는 아님", link("https://github.com/example-org/app/issues/8392") === null);
check("pull 목록 주소는 아님", link("https://github.com/example-org/app/pulls") === null);
check("저장소 주소는 아님", link("https://github.com/example-org/app") === null);
check("다른 호스트는 아님", link("https://example.com/example-org/app/pull/1") === null);
check("http 는 아님", link("http://github.com/example-org/app/pull/1") === null);
check("번호 뒤에 글자가 붙으면 아님(.diff)", link(`${base}.diff`) === null && link(`${base}abc`) === null);
check("www.github.com 은 PR 주소", link("https://www.github.com/a/b/pull/3")?.number === 3);
check("점과 밑줄이 든 저장소 이름", link("https://github.com/a.b/c_d-e/pull/3")?.repo === "a.b/c_d-e");
check("prRefOfUrl 은 저장소와 번호만", same(prRefOfUrl(`${base}/files#r1`), { repo: "example-org/app", number: 8392 }) && prRefOfUrl("https://github.com/a/b") === null);
check("anchorKey", anchorKey({ kind: "comment", id: "5" }) === "comment-5" && anchorKey({ kind: "review", id: "6" }) === "review-6" && anchorKey({ kind: "checks" }) === "checks");

const comment = (anchorId: string | null) => ({ id: `C_${anchorId}`, anchorId, author: null, body: "", createdAt: "", updatedAt: null, viewerCanUpdate: false, viewerCanDelete: false, pending: false, reviewId: null });
const detail = {
  timeline: [{ kind: "comment", comment: comment("100") }, { kind: "review", id: "R1", anchorId: "200", author: null, state: "COMMENTED", body: "", createdAt: "" }],
  threads: [{ id: "T1", path: "src/a.ts", comments: [comment("300"), comment("301")] }],
} as unknown as PrDetail;
check("일반 코멘트는 Overview", same(resolveFocus(detail, { kind: "comment", id: "100" }), { tab: "overview", file: null }));
check("리뷰 스레드 코멘트는 Files 의 그 파일", same(resolveFocus(detail, { kind: "comment", id: "301" }), { tab: "files", file: "src/a.ts" }));
check("리뷰 요약은 Overview", same(resolveFocus(detail, { kind: "review", id: "200" }), { tab: "overview", file: null }));
check("checks 는 Overview", same(resolveFocus(detail, { kind: "checks" }), { tab: "overview", file: null }));
check("없는 코멘트는 null", resolveFocus(detail, { kind: "comment", id: "999" }) === null && resolveFocus(detail, { kind: "review", id: "999" }) === null);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
