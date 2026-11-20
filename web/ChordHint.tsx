import { useChordHint } from "./chordState";

// 단축키 두 번째 키를 기다리는 동안과 취소됐을 때의 한 줄 안내.
export function ChordHint() {
  const hint = useChordHint();
  if (!hint) return null;
  return (
    <div className="chord-hint" role="status" data-kind={hint.kind}>
      {hint.text}
    </div>
  );
}
