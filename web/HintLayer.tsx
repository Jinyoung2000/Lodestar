import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { dismissHint, useHint, type HintBubble } from "./hint";
import { dismissesOnKey, hintDuration, placeBubble, type Placement } from "./hintModel";
import { Check } from "./icons";
import "./hint.css";

// 에디터 밖 동작의 사소한 결과를 동작 자리 옆에 잠깐 보이는 말풍선. 에디터 안은 web/editorMessage.ts 가 커서 위에 띄운다.
// 다음 키 입력, 누름, 스크롤, 창 포커스 이탈, 시간이 다 되면 사라진다. 소리는 web/LiveAnnouncer.tsx 가 읽으므로 상자는 aria-hidden 이다.
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
    // 안내를 띄운 단축키 자신의 keydown 이 곧바로 닫지 않게 한다
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
