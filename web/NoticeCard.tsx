import { ErrorIcon, InfoIcon, Warning, Close } from "./icons";
import type { NoticeAction, NoticeSeverity } from "./notices";
import { S } from "./strings";
import { Button } from "./ui/button";

type NoticeCardProps = {
  severity: NoticeSeverity;
  message: string;
  detail?: string | null;
  actions?: NoticeAction[];
  onClose: () => void;
  // 마우스가 올라가 있는 동안 true. 자동으로 사라지는 알림이 멈추는 데 쓴다.
  onHold?: (held: boolean) => void;
  // 시험과 e2e 가 카드를 집는 데 쓰는 data-* 속성
  data?: Record<string, string | undefined>;
};

// 알림 한 장: 아이콘, 메시지, (이유), 버튼 줄, 닫기. 토스트 스택 안의 모든 알림이 이 모양을 쓴다.
export function NoticeCard({ severity, message, detail, actions = [], onClose, onHold, data }: NoticeCardProps) {
  return (
    <div className="notice-card" role={severity === "error" ? "alert" : "status"} data-severity={severity} onMouseEnter={onHold && (() => onHold(true))} onMouseLeave={onHold && (() => onHold(false))} {...data}>
      <span className="notice-icon">
        <SeverityIcon severity={severity} />
      </span>
      <div className="notice-body">
        <div className="notice-message">{message}</div>
        {detail && <div className="notice-detail">{detail}</div>}
      </div>
      <Button size="icon" className="notice-close" aria-label={S.noticeDismiss} title={S.noticeDismiss} onClick={onClose}>
        <Close />
      </Button>
      {actions.length > 0 && (
        <div className="notice-actions">
          {actions.map((action) => (
            <Button
              key={action.label}
              size="sm"
              variant={action.primary ? "primary" : "secondary"}
              title={action.label}
              disabled={action.disabled}
              onClick={() => {
                action.run();
                if (!action.keepOpen) onClose();
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function SeverityIcon({ severity }: { severity: NoticeSeverity }) {
  if (severity === "error") return <ErrorIcon />;
  if (severity === "warning") return <Warning />;
  return <InfoIcon />;
}
