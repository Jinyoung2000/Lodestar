import type { FeedbackRunner } from "./feedback";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type FeedbackHandlerDeps = { feedback: FeedbackRunner };

export function feedbackHandlers(deps: FeedbackHandlerDeps): HandlersFor<MethodsIn<"feedback">> {
  const { feedback } = deps;
  return {
    "feedback.create": (params) => feedback.create(params),
    "feedback.sourceReady": async () => ({ ready: await feedback.sourceReady() }),
    "feedback.list": () => feedback.list(),
    "feedback.revert": ({ id }) => feedback.revert(id),
    "feedback.restart": ({ id }) => feedback.requestRestart(id),
    "feedback.retryChecks": ({ id }) => feedback.retryChecks(id),
    "feedback.runAgain": ({ id }) => feedback.runAgain(id),
    "feedback.resolve": ({ id }) => feedback.resolve(id),
    "feedback.dismiss": ({ id }) => feedback.dismiss(id),
    "feedback.markSeen": ({ id }) => {
      feedback.markSeen(id);
      return null;
    },
    "feedback.tidyPlan": ({ policy }) => feedback.tidyPlan(policy ?? {}),
    "feedback.tidyRun": ({ policy }) => feedback.tidyRun(policy ?? {}),
  };
}
