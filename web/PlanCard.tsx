import { useState } from "react";
import { planText } from "../shared/interactive";
import { ApprovalHints } from "./ApprovalHints";
import { Close } from "./icons";
import { PermissionModeIcon } from "./PermissionMenu";
import { rpc } from "./rpc";
import { flash } from "./store";
import { S } from "./strings";
import { Markdown } from "./Timeline";
import { Button } from "./ui/button";
import type { PermissionItem } from "./timelineModel";

type AfterMode = "acceptEdits" | "default";
const AFTER_MODES: AfterMode[] = ["acceptEdits", "default"];

// ExitPlanMode 로 올라온 계획 승인 카드. 계획은 마크다운으로 보이고, 승인하면 고른 권한 모드(자동 편집 또는 편집 전 확인)로 이어서 진행한다.
// Keep planning 은 입력창 아래 글(없어도 된다)과 함께 거절로 돌아가 모델이 계획을 고친다.
export function PlanCard({ agentId, item }: { agentId: string; item: PermissionItem }) {
  const plan = planText(item.input);
  const [mode, setMode] = useState<AfterMode>("acceptEdits");
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const send = (params: { approve: true; mode: AfterMode } | { approve: false; feedback?: string }) => {
    if (sending) return;
    setSending(true);
    rpc.call("agents.respondPlan", { agentId, itemId: item.id, ...params }).catch((error: Error) => {
      flash(error.message);
      setSending(false);
    });
  };
  const keep = () => send({ approve: false, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) });
  return (
    <div className="approval-card plan-card" role="group" aria-label={S.planTitle}>
      <div className="approval-head">
        <span className="approval-title">{S.planTitle}</span>
        <button type="button" className="icon-button" aria-label={S.planKeep} title={S.planKeep} onClick={keep}>
          <Close />
        </button>
      </div>
      <div className="plan-body">{plan ? <Markdown className="plan-markdown" text={plan} /> : <div className="plan-empty">{S.planNoText}</div>}</div>
      <div className="plan-after" role="radiogroup" aria-label={S.planModeAria}>
        <span className="plan-after-label">{S.planAfter}</span>
        {AFTER_MODES.map((value) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value} className="plan-mode" data-selected={mode === value || undefined} onClick={() => setMode(value)}>
            <PermissionModeIcon mode={value} size={12} />
            <span>{S.permissionModes[value]}</span>
          </button>
        ))}
      </div>
      <textarea className="plan-feedback" rows={2} aria-label={S.planFeedbackPlaceholder} placeholder={S.planFeedbackPlaceholder} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="approval-actions">
        <Button variant="primary" size="default" data-approval-primary disabled={sending} onClick={() => send({ approve: true, mode })}>
          {S.planApprove}
        </Button>
        <Button variant="secondary" size="default" disabled={sending} onClick={keep}>
          {S.planKeep}
        </Button>
        <ApprovalHints hints={S.approvalFocusHints} />
      </div>
    </div>
  );
}
