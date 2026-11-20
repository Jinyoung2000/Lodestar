import { useEffect, useRef } from "react";
import { FeedbackNotices } from "./Feedback";
import { HintLayer } from "./HintLayer";
import { NoticeCard } from "./NoticeCard";
import { dismissNotice, holdNotice, useNotices } from "./notices";
import { useStore } from "./store";

// 입력창이 있는 곳. 알림이 이 위를 덮지 않게 스택을 입력창 위로 올린다.
const AVOID = ".composer, .side .composer-box, .float-pill";
const LIFT_POLL_MS = 250;

export function NoticeStack() {
  const notices = useNotices();
  const hint = useStore((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  useLiftAboveComposer(ref);
  return (
    <>
      <div className="toast-stack" ref={ref} data-testid="notification-stack">
        <FeedbackNotices />
        {notices.map((notice) => (
          <NoticeCard key={notice.id} severity={notice.severity} message={notice.message} detail={notice.detail} actions={notice.actions} onClose={() => dismissNotice(notice.id)} onHold={(held) => holdNotice(notice.id, held)} />
        ))}
        {hint && (
          <div className="toast" role="status">
            {hint}
          </div>
        )}
      </div>
      <HintLayer />
    </>
  );
}

// 스택이 어떤 입력창과 가로로 겹치면 그 입력창 위쪽 가장자리 위에 서도록 --notice-above 에 입력창 위 가장자리에서 창 바닥까지의 거리를 넣는다.
// 입력창은 글을 쓰면 키가 자라고 칸이 바뀌어도 움직여서, 스택에 뭔가 있는 동안 짧은 간격으로 다시 잰다.
function useLiftAboveComposer(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    // 스택이 비어 있고 정리도 끝났으면 250ms 마다 DOM 을 훑지 않는다(대화가 길면 querySelectorAll 과 강제 레이아웃이 유휴 CPU 를 먹었다).
    let cleared = false;
    const measure = () => {
      const stack = ref.current;
      if (!stack) return;
      if (stack.childElementCount === 0) {
        if (cleared) return;
        cleared = true;
        stack.style.removeProperty("--notice-above");
        coverTimelines(null);
        return;
      }
      cleared = false;
      // 올리지 않은 기본 자리(창 오른쪽 아래)에서 재서, 입력창과 실제로 겹칠 때만 올린다. 입력창이 화면 가운데 있어도 알림이 따라 올라가지 않는다.
      stack.style.removeProperty("--notice-above");
      const box = stack.getBoundingClientRect();
      let above = 0;
      for (const el of document.querySelectorAll(AVOID)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.right <= box.left || rect.left >= box.right || rect.bottom <= box.top) continue;
        above = Math.max(above, window.innerHeight - rect.top);
      }
      if (above > 0) stack.style.setProperty("--notice-above", `${above}px`);
      else stack.style.removeProperty("--notice-above");
      coverTimelines(stack.getBoundingClientRect());
    };
    measure();
    const timer = setInterval(measure, LIFT_POLL_MS);
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
}

// 알림이 대화 영역의 아래쪽을 덮으면 그 대화 바닥에 알림 높이만큼 빈 자리를 더해, 마지막 메시지들이 알림 위로 올라와 읽히게 한다(round-5 발견 18: 알림이 입력창 위 대화 끝을 덮었다).
// 바닥을 따라가던 대화는 빈 자리가 생긴 뒤에도 바닥에 붙어 있게 다시 내린다. rect 가 null 이면 모두 거둔다.
function coverTimelines(rect: DOMRect | null) {
  for (const timeline of document.querySelectorAll<HTMLElement>(".timeline")) {
    const box = timeline.getBoundingClientRect();
    const overlaps = !!rect && box.width > 0 && rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
    const cover = overlaps && rect ? Math.max(0, Math.round(box.bottom - rect.top)) : 0;
    const before = Number.parseFloat(timeline.style.getPropertyValue("--notice-cover")) || 0;
    if (cover === before) continue;
    const following = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
    if (cover > 0) timeline.style.setProperty("--notice-cover", `${cover}px`);
    else timeline.style.removeProperty("--notice-cover");
    if (following) timeline.scrollTop = timeline.scrollHeight;
  }
}
