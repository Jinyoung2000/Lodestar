// 피드백 요약을 뽑을 답을 고르는 규칙 단독 시험(shared/feedbackSummary.ts). 사고 사례: 2744382d 는 다시 검사로 반영됐는데 요약이 자동 수정 턴의 "npm 이 없어서 고칠 수 없습니다" 로 남았다.
// 실행: npm test
import type { TimelineItem } from "../shared/protocol";
import { summarySource } from "../shared/feedbackSummary";
import { T } from "../server/strings";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

let seq = 0;
const user = (text: string, shown?: string): TimelineItem => ({ id: `u${seq++}`, kind: "user", text, shown, source: "user" });
const assistant = (text: string): TimelineItem => ({ id: `a${seq++}`, kind: "assistant", text }) as TimelineItem;
const tool = (): TimelineItem => ({ id: `t${seq++}`, kind: "tool" }) as unknown as TimelineItem;
const notice = (text: string): TimelineItem => ({ id: `n${seq++}`, kind: "notice", text }) as unknown as TimelineItem;
const fix = (attempt: number) => user("The check \"npm run build\" failed after your changes. ...long prompt...", T.fbFixShown("npm run build", attempt, 2));

// 1. 문구 판정: 자동 수정 턴의 화면용 문구만 참
check("the auto-fix shown text is recognised", T.fbIsFixShown(T.fbFixShown("npm run build", 1, 2)) && T.fbIsFixShown(T.fbFixShown("npx tsc --noEmit", 2, 2)));
check("a feedback request and a resume line are not auto-fix", !T.fbIsFixShown("Feedback: the text overlaps the buttons") && !T.fbIsFixShown(T.fbResumeShown));

// 2. 2744382d 와 같은 모양: 첫 턴의 답이 요약이고, 자동 수정 턴의 답은 건너뛴다
{
  const items = [
    user("Feedback: overlap", "the text overlaps the buttons"),
    tool(),
    assistant("Title padding reserves space for fewer buttons than are shown."),
    tool(),
    assistant("제목 오른쪽 여백을 버튼 개수에 맞춰 늘렸습니다(hover 3개, 선택 행 4개). 이 환경에 npx와 npm이 없어 tsc는 실행하지 못했습니다."),
    notice("npm run build failed"),
    fix(1),
    assistant("`npm run build`가 실패한 건 이 환경 PATH에 npm이 없어서(`spawn npm ENOENT`)이고, 제 CSS 수정과는 무관합니다."),
    fix(2),
    assistant("npm이 실행 환경에 없어서 생기는 `spawn npm ENOENT` 오류라 코드로는 고칠 수 없습니다."),
    notice("Running the checks again"),
    fix(1),
    assistant("`spawn npm ENOENT`는 실행 환경에 npm이 없어서 나는 오류라 제 CSS 수정과는 무관합니다."),
  ];
  const picked = summarySource(items, T.fbIsFixShown);
  check("picks the last reply of the first turn, not the auto-fix replies", picked?.startsWith("제목 오른쪽 여백을") === true, String(picked));
}

// 3. 사람이 보낸 후속 턴의 답은 대상이다(가장 마지막 것)
{
  const items = [user("first", "first"), assistant("Moved the badge."), user("also make it bigger", "also make it bigger"), assistant("Made the badge bigger too."), fix(1), assistant("Cannot fix npm.")];
  check("a human follow-up turn counts, the later reply wins", summarySource(items, T.fbIsFixShown) === "Made the badge bigger too.");
}

// 4. 대상 답이 없으면 null(호출한 쪽이 피드백 문장으로 대신한다)
{
  check("no reply at all", summarySource([user("x", "x")], T.fbIsFixShown) === null);
  check("only auto-fix replies", summarySource([user("x", "x"), fix(1), assistant("no npm")], T.fbIsFixShown) === null);
  check("empty reply text is skipped", summarySource([user("x", "x"), assistant("Real answer."), assistant("   ")], T.fbIsFixShown) === "Real answer.");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
