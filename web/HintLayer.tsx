import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { dismissHint, useHint, type HintBubble } from "./hint";
import { dismissesOnKey, hintDuration, placeBubble, type Placement } from "./hintModel";
import { Check } from "./icons";
import "./hint.css";

export function HintLayer() {
  const bubble = useHint();
  if (!bubble) return null;
  return <HintBox key={bubble.id} bubble={bubble} />;
}

function HintBox({ bubble }: { bubble: HintBubble }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const style = getComputedStyle(document.documentElement);
    const gap = Number.parseFloat(style.getPropertyValue("--space-2")) || 0;
    const margin = Number.parseFloat(style.getPropertyValue("--space-2")) || 0;
    const { width, height } = box.getBoundingClientRect();
    setPlacement(placeBubble(bubble.rect, { width, height }, { width: window.innerWidth, height: window.innerHeight }, gap, margin));
  }, [bubble]);
  useDismiss(bubble);
  return (
    <div ref={ref} className="hint-bubble" role="presentation" aria-hidden="true" data-testid="hint-bubble" data-side={placement?.side} style={placement ? { left: placement.left, top: placement.top } : { visibility: "hidden" }}>
      {bubble.check && <Check className="hint-check" />}
      <span>{bubble.text}</span>
    </div>
  );
}

function useDismiss(bubble: HintBubble) {
  useEffect(() => {
    const shownAt = performance.now();
    const close = () => dismissHint(bubble.id);
    const onKey = (event: KeyboardEvent) => {
      if (event.timeStamp > shownAt && dismissesOnKey(event.key)) close();
    };
    const timer = setTimeout(close, hintDuration(bubble.text));
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, [bubble]);
}
