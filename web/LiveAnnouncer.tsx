import { useAnnouncement } from "./announce";

// 화면 낭독기용 안내 영역. 보이지 않는다. 응답 완료는 status(polite), 승인 요청은 alert 로 읽힌다.
export function LiveAnnouncer() {
  const { polite, urgent, nonce } = useAnnouncement();
  return (
    <div className="sr-only">
      <div role="status" aria-live="polite" aria-atomic="true">
        <span key={nonce}>{polite}</span>
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        <span key={nonce}>{urgent}</span>
      </div>
    </div>
  );
}
