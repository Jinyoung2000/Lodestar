import { useMemo, useState } from "react";
import { answersOf, emptyQuestionState, isAnswered, readQuestions, toggleOther, togglePick, type Question, type QuestionState } from "../shared/interactive";
import { ApprovalHints } from "./ApprovalHints";
import { Check, Close } from "./icons";
import { rpc } from "./rpc";
import { flash } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import type { PermissionItem } from "./timelineModel";

// 모델이 AskUserQuestion 으로 묻는 질문 카드(입력창 바로 위). 질문마다 선택지를 단추로 보이고 Other 에는 직접 쓴다.
// 모든 질문에 답이 있어야 Submit 이 켜진다. 답은 질문 글 -> 고른 선택지(여러 개는 ", ")로 서버에 가서 도구 결과가 된다. Skip 은 답하지 않고 넘긴다.
export function QuestionCard({ agentId, item }: { agentId: string; item: PermissionItem }) {
  const questions = useMemo(() => readQuestions(item.input), [item.input]);
  const [states, setStates] = useState<QuestionState[]>(() => questions.map(emptyQuestionState));
  const [sending, setSending] = useState(false);
  const ready = isAnswered(questions, states) && !sending;
  const send = (answers: Record<string, string> | null) => {
    if (sending) return;
    setSending(true);
    rpc.call("agents.answerQuestion", { agentId, itemId: item.id, answers }).catch((error: Error) => {
      flash(error.message);
      setSending(false);
    });
  };
  const submit = () => {
    if (ready) send(answersOf(questions, states));
  };
  return (
    <div className="approval-card question-card" role="group" aria-label={S.questionTitle}>
      <div className="approval-head">
        <span className="approval-title">{S.questionTitle}</span>
        <button type="button" className="icon-button" aria-label={S.questionSkip} title={S.questionSkip} onClick={() => send(null)}>
          <Close />
        </button>
      </div>
      <div className="question-list">
        {questions.map((question, index) => (
          <QuestionBlock
            key={question.question}
            question={question}
            state={states[index]}
            onChange={(next) => setStates((list) => list.map((state, i) => (i === index ? next : state)))}
            onSubmit={submit}
          />
        ))}
      </div>
      <div className="approval-actions">
        <Button variant="primary" size="default" data-approval-primary disabled={!ready} title={ready ? undefined : S.questionPickOne} onClick={submit}>
          {S.questionSubmit}
        </Button>
        <Button variant="secondary" size="default" onClick={() => send(null)}>
          {S.questionSkip}
        </Button>
        <ApprovalHints hints={S.approvalFocusHints} />
      </div>
    </div>
  );
}

function QuestionBlock({ question, state, onChange, onSubmit }: { question: Question; state: QuestionState; onChange: (next: QuestionState) => void; onSubmit: () => void }) {
  const kind = question.multiSelect ? "check" : "radio";
  return (
    <div className="question-block" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question}>
      <div className="question-head">
        {question.header && <span className="question-header">{question.header}</span>}
        <span className="question-text">{question.question}</span>
      </div>
      <div className="question-options">
        {question.options.map((option) => {
          const selected = state.picked.includes(option.label);
          return (
            <button key={option.label} type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={selected} className="question-option" data-selected={selected || undefined} onClick={() => onChange(togglePick(question, state, option.label))}>
              <span className="question-mark" data-kind={kind} aria-hidden="true">
                {selected && (question.multiSelect ? <Check size={12} /> : <span className="question-dot" />)}
              </span>
              <span className="question-option-text">
                <span className="question-option-label">{option.label}</span>
                {option.description && <span className="question-option-desc">{option.description}</span>}
              </span>
            </button>
          );
        })}
        <div className="question-option question-other" data-selected={state.other || undefined}>
          <button type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={state.other} aria-label={S.questionOther} className="question-other-toggle" onClick={() => onChange(toggleOther(question, state))}>
            <span className="question-mark" data-kind={kind} aria-hidden="true">
              {state.other && (question.multiSelect ? <Check size={12} /> : <span className="question-dot" />)}
            </span>
            <span className="question-option-label">{S.questionOther}</span>
          </button>
          <input
            type="text"
            className="question-other-input"
            aria-label={S.questionOther}
            placeholder={S.questionOtherPlaceholder}
            value={state.text}
            onFocus={() => {
              if (!state.other) onChange(toggleOther(question, state));
            }}
            onChange={(e) => onChange({ ...(state.other ? state : toggleOther(question, state)), text: e.target.value })}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key !== "Enter") return;
              e.preventDefault();
              onSubmit();
            }}
          />
        </div>
      </div>
    </div>
  );
}
