export type ApprovalHint = { keys: string; label: string };

export function ApprovalHints({ hints }: { hints: readonly ApprovalHint[] }) {
  return (
    <span className="approval-hints" aria-hidden="true">
      {hints.map((hint) => (
        <span key={hint.keys} className="approval-hint">
          <kbd>{hint.keys}</kbd>
          <span>{hint.label}</span>
        </span>
      ))}
    </span>
  );
}
