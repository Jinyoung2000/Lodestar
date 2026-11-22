import { useAnnouncement } from "./announce";

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
