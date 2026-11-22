import { useEffect, useRef } from "react";
import { FeedbackNotices } from "./Feedback";
import { HintLayer } from "./HintLayer";
import { NoticeCard } from "./NoticeCard";
import { dismissNotice, holdNotice, useNotices } from "./notices";
import { useStore } from "./store";

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

function useLiftAboveComposer(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
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
