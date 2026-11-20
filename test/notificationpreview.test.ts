// 응답 완료 알림 본문(shared/notificationPreview.ts): 마지막 답의 마크다운을 한 줄 글로 줄인다. 실행: npm test
import { notificationPreview } from "../shared/notificationPreview";

const cases: { name: string; input: string; max?: number; want: string | null }[] = [
  { name: "제목, 굵게, 목록, 링크, 코드 표시를 걷는다", input: "## 결과\n\n**세 가지** 모두 고쳤습니다.\n- [diffMarks.ts](web/diffMarks.ts) 의 `lineFirstDiff`\n1. 테스트 통과", want: "결과 세 가지 모두 고쳤습니다. diffMarks.ts 의 lineFirstDiff 테스트 통과" },
  { name: "코드 블록은 통째로 뺀다", input: "AS-IS:\n```ts\nconst a = 1;\n```\nTO-BE 입니다.", want: "AS-IS: TO-BE 입니다." },
  { name: "표는 칸 글만 남긴다", input: "| 경로 | 결과 |\n| --- | --- |\n| a.ts | 숨김 |", want: "경로 결과 a.ts 숨김" },
  { name: "길면 말줄임표로 자른다", input: "가".repeat(200), max: 10, want: `${"가".repeat(9)}…` },
  { name: "글이 없으면 null", input: "```\nonly code\n```\n", want: null },
];

let failed = 0;
for (const c of cases) {
  const got = notificationPreview(c.input, c.max);
  if (got === c.want) console.log(`ok   ${c.name}`);
  else {
    failed++;
    console.log(`FAIL ${c.name}: ${JSON.stringify(got)} !== ${JSON.stringify(c.want)}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
