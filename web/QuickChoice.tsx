import { useEffect, useRef, useState } from "react";
import { DEVICE_PLACEHOLDER, devicePickerTitle, filterDevices, type DeviceRequest } from "./browserDevices";
import { Palette } from "./Palette";
import { setState } from "./store";
import { S } from "./strings";

// 한 가지를 고르는 빠른 선택창 둘: 에이전트가 공유할 열린 탭을 묻는 창(openChoice)과 기기 요청 선택창(DevicePicker). 같은 목록 모양을 쓴다.

export type ChoiceItem = { id: string; label: string; detail?: string };
type Pending = { title: string; placeholder: string; items: ChoiceItem[]; resolve: (id: string | null) => void };
const pending = new Map<string, Pending>();

// 선택창을 열고 고른 항목 id(취소는 null)를 기다린다.
export function openChoice(options: { title: string; placeholder: string; items: ChoiceItem[] }): Promise<string | null> {
  const id = `choice-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve) => {
    pending.set(id, { ...options, resolve });
    setState({ overlay: { kind: "choice", id } });
  });
}

export function ChoiceOverlay({ id }: { id: string }) {
  const entry = pending.get(id);
  const answered = useRef(false);
  const answer = (value: string | null) => {
    if (answered.current) return;
    answered.current = true;
    pending.delete(id);
    entry?.resolve(value);
    setState((s) => (s.overlay?.kind === "choice" && s.overlay.id === id ? { overlay: null } : {}));
  };
  // 창이 다른 것으로 바뀌어 사라질 때도 답을 남긴다
  useEffect(() => () => answer(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!entry) return null;
  return <ChoiceList title={entry.title} placeholder={entry.placeholder} items={entry.items} onChoose={answer} />;
}

// 기기 요청 하나. 메인이 목록을 갱신하면(request 가 바뀌면) 같은 창에서 목록만 바뀐다. 닫으면 취소로 답한다.
export function DevicePicker({ request }: { request: DeviceRequest }) {
  const answered = useRef(false);
  const requestId = request.requestId;
  const answer = (deviceId: string | null) => {
    if (answered.current) return;
    answered.current = true;
    void window.agentNavNative?.browserDeviceAnswer?.(requestId, deviceId);
    setState((s) => (s.overlay?.kind === "device" && s.overlay.request.requestId === requestId ? { overlay: null } : {}));
  };
  useEffect(() => () => answer(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <ChoiceList title={devicePickerTitle(request.origin, request.deviceType)} placeholder={DEVICE_PLACEHOLDER} items={request.devices.map((d) => ({ id: d.deviceId, label: d.label, detail: d.detail }))} busy onChoose={answer} />;
}

function ChoiceList({ title, placeholder, items, busy = false, onChoose }: { title: string; placeholder: string; items: ChoiceItem[]; busy?: boolean; onChoose: (id: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const rows = filterDevices(items.map((i) => ({ deviceId: i.id, label: i.label, detail: i.detail })), query);
  const active = Math.min(index, Math.max(rows.length - 1, 0));
  return (
    <Palette
      quickpick
      title={title}
      busy={busy}
      count={S.resultCount(rows.length)}
      label={title}
      placeholder={placeholder}
      query={query}
      onQuery={(value) => {
        setQuery(value);
        setIndex(0);
      }}
      onClose={() => onChoose(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIndex(Math.min(active + 1, rows.length - 1));
        if (e.key === "ArrowUp") setIndex(Math.max(active - 1, 0));
        if (e.key === "Enter" && !e.nativeEvent.isComposing && rows[active]) onChoose(rows[active].deviceId);
      }}
      footer={null}
    >
      {rows.map((row, i) => (
        <button key={row.deviceId} type="button" className="quickpick-row" data-choice-option data-active={i === active || undefined} onClick={() => onChoose(row.deviceId)}>
          <span className="quickpick-text">
            <span className="quickpick-title">{row.label}</span>
            {row.detail && <span className="quickpick-detail faint">{row.detail}</span>}
          </span>
        </button>
      ))}
    </Palette>
  );
}
