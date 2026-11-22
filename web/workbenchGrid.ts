
const PRIMARY_COLUMN = ":scope > .sidebar, :scope > .focus-side";

function body(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".body");
}

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
