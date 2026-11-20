// 작업 영역(.body) 격자의 실제 크기를 읽는 DOM 쪽 도우미. 격자 배치 계산은 web/layoutConfig.ts 에 있다.
//
// .center 와 .center-and-bottom 은 display: contents 라서 자기 상자가 없다(getBoundingClientRect 가 0). 예전에 .center 폭이던 값,
// 곧 사이드바(Primary Side Bar) 열을 뺀 가운데와 오른쪽 패널을 합친 폭이 필요한 계산은 centerWidth() 로 읽는다.
// CSS 도 같은 값을 --center-w 로 받는다(.right 의 기본 폭 54% 와 min, max 가 이 폭 기준이다).

const PRIMARY_COLUMN = ":scope > .sidebar, :scope > .focus-side";

function body(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".body");
}

// .body 폭에서 사이드바 열(앱 사이드바나 Editor 중심의 사이드바)을 뺀 폭
export function centerWidth(): number {
  const el = body();
  if (!el) return 0;
  let width = el.getBoundingClientRect().width;
  for (const column of el.querySelectorAll(PRIMARY_COLUMN)) width -= column.getBoundingClientRect().width;
  return Math.max(0, Math.round(width));
}

export function bodyHeight(): number {
  return body()?.getBoundingClientRect().height ?? 0;
}

// --center-w 를 그 값을 쓰는 요소(오른쪽 패널 .right, 대화 패널 .panes[data-dock])에 직접 건다. .body 와 사이드바 열의 크기가 바뀔 때마다 다시 건다. 돌려주는 함수가 감시를 끝낸다.
// .body 에 걸면 상속돼서 값이 바뀔 때마다 자손 전체가 스타일을 다시 계산한다(web/styles.css 의 @property 등록 참고). 쓰는 요소가 새로 생기면(패널 열기 등) 호출 쪽이 이 함수를 다시 불러야 한다.
const CENTER_CONSUMERS = ".center > .right, .center > .panes[data-dock]";

export function watchCenterWidth(): () => void {
  const el = body();
  if (!el) return () => undefined;
  const apply = () => {
    const value = `${centerWidth()}px`;
    for (const consumer of el.querySelectorAll<HTMLElement>(CENTER_CONSUMERS)) consumer.style.setProperty("--center-w", value);
  };
  apply();
  const observer = new ResizeObserver(apply);
  observer.observe(el);
  for (const column of el.querySelectorAll(PRIMARY_COLUMN)) observer.observe(column);
  return () => observer.disconnect();
}
