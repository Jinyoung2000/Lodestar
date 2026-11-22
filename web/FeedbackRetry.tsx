import { useState } from "react";
import type { Feedback } from "../shared/protocol";
import { canRetryChecks } from "../shared/feedbackRetry";
import { canRunAgain } from "../shared/feedbackResume";
import { Refresh } from "./icons";
import { rpc } from "./rpc";
import { flash, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

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

export const retryLabel = (feedback: Pick<Feedback, "conflict">) => (feedback.conflict ? S.feedbackMergeAgain : S.feedbackRetry);

export async function retryFeedbackChecks(feedback: Feedback) {
  try {
    await rpc.call("feedback.retryChecks", { id: feedback.id });
  } catch (error) {
    flash(S.feedbackRetryFailed((error as Error).message.split("\n")[0]));
  }
}

export async function runFeedbackAgain(feedback: Feedback) {
  try {
    await rpc.call("feedback.runAgain", { id: feedback.id });
  } catch (error) {
    flash(S.feedbackRunAgainFailed((error as Error).message.split("\n")[0]));
  }
}
