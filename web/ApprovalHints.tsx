// 승인 카드 단추줄 오른쪽의 단축키 힌트. 흐린 색의 글자라서 눈에 걸리지 않고, 폭이 모자라면 오른쪽부터 말줄임으로 줄어든다.
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
