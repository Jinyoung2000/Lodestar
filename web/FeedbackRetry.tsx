import { useState } from "react";
import type { Feedback } from "../shared/protocol";
import { canRetryChecks } from "../shared/feedbackRetry";
import { canRunAgain } from "../shared/feedbackResume";
import { Refresh } from "./icons";
import { rpc } from "./rpc";
import { flash, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

// 피드백 세션 대화의 실패 알림 아래 단추. 지금 이 알림이 피드백의 현재 실패일 때만(이전 실패 알림에는 안 붙는다) 보인다.
export function FeedbackRetryRow({ agentId, text, detail }: { agentId: string; text: string; detail?: string }) {
  const feedback = useStore((s) => Object.values(s.feedbacks).find((f) => f.agentId === agentId));
  const [busy, setBusy] = useState(false);
  if (!feedback || feedback.failure !== (detail ? `${text}\n${detail}` : text)) return null;
  const retry = canRetryChecks(feedback);
  const again = canRunAgain(feedback);
  if (!retry && !again) return null;
  return (
    <div className="feedback-retry-row">
      {retry && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void retryFeedbackChecks(feedback).finally(() => setBusy(false));
          }}
        >
          <Refresh size={14} />
          {busy ? S.feedbackRetrying : retryLabel(feedback)}
        </Button>
      )}
      {again && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void runFeedbackAgain(feedback).finally(() => setBusy(false));
          }}
        >
          <Refresh size={14} />
          {S.feedbackRunAgain}
        </Button>
      )}
    </div>
  );
}

// 본 작업 폴더와 합쳐지지 않아 실패한 피드백(conflict)은 같은 동작이 Merge Again 으로 보인다.
export const retryLabel = (feedback: Pick<Feedback, "conflict">) => (feedback.conflict ? S.feedbackMergeAgain : S.feedbackRetry);

// 알림, 사이드바 메뉴, 대화 세 곳이 같이 쓰는 호출. 거절 이유는 알림으로 알린다.
export async function retryFeedbackChecks(feedback: Feedback) {
  try {
    await rpc.call("feedback.retryChecks", { id: feedback.id });
  } catch (error) {
    flash(S.feedbackRetryFailed((error as Error).message.split("\n")[0]));
  }
}

// FBREDO: 재시작에 끊겨 이어 가지 못한 피드백을 같은 요청으로 새 개선 세션에서 처음부터 다시 돌린다. 새 피드백은 feedback 이벤트로 목록에 들어온다.
export async function runFeedbackAgain(feedback: Feedback) {
  try {
    await rpc.call("feedback.runAgain", { id: feedback.id });
  } catch (error) {
    flash(S.feedbackRunAgainFailed((error as Error).message.split("\n")[0]));
  }
}
