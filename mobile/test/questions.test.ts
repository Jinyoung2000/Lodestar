import * as shared from "../../shared/interactive";
import * as mobile from "../src/logic/questions";
import { expect, run, test } from "./harness";

const input = { questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "first" }, { label: "B", description: "" }] }, { question: "More?", header: "", multiSelect: true, options: [{ label: "X", description: "" }, { label: "Y", description: "" }, { label: "", description: "dropped" }] }, "junk", { question: "  ", options: [] }], plan: "  1. step\n2. step  " };

test("질문 읽기와 답 만들기는 shared/interactive.ts 와 같은 결과를 낸다", () => {
  const a = shared.readQuestions(input);
  const b = mobile.readQuestions(input);
  expect(JSON.stringify(a) === JSON.stringify(b) && b.length === 2, JSON.stringify(b));
  const states = [
    mobile.togglePick(b[0], mobile.emptyQuestionState(), "B"),
    mobile.toggleOther(b[1], mobile.togglePick(b[1], mobile.togglePick(b[1], mobile.emptyQuestionState(), "Y"), "X")),
  ];
  const sharedStates = [shared.togglePick(a[0], shared.emptyQuestionState(), "B"), shared.toggleOther(a[1], shared.togglePick(a[1], shared.togglePick(a[1], shared.emptyQuestionState(), "Y"), "X"))];
  states[1] = { ...states[1], text: " custom " };
  sharedStates[1] = { ...sharedStates[1], text: " custom " };
  expect(JSON.stringify(mobile.answersOf(b, states)) === JSON.stringify(shared.answersOf(a, sharedStates)), JSON.stringify(mobile.answersOf(b, states)));
  expect(mobile.answersOf(b, states)["More?"] === "X, Y, custom", "multi select keeps option order and appends other text");
  expect(mobile.isAnswered(b, states) === shared.isAnswered(a, sharedStates) && mobile.isAnswered(b, states), "answered");
  expect(!mobile.isAnswered(b, [states[0]]), "second question unanswered");
  expect(mobile.planText(input) === shared.planText(input) && mobile.planText(input) === "1. step\n2. step", "plan text");
  expect(mobile.QUESTION_TOOL === shared.QUESTION_TOOL && mobile.PLAN_TOOL === shared.PLAN_TOOL, "tool names");
  return "ok";
});

void run();
