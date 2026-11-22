import { useChordHint } from "./chordState";

export function ChordHint() {
  const hint = useChordHint();
  if (!hint) return null;
  return (
    <div className="chord-hint" role="status" data-kind={hint.kind}>
      {hint.text}
    </div>
  );
}
