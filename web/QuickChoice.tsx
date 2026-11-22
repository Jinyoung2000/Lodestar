import { Fragment, useEffect, useRef, useState } from "react";
import { DEVICE_PLACEHOLDER, devicePickerTitle, filterDevices, type DeviceRequest } from "./browserDevices";
import { Codicon } from "./icons";
import { Palette } from "./Palette";
import { setState } from "./store";
import { S } from "./strings";

export type ChoiceItem = { id: string; label: string; detail?: string; icon?: string; separatorBefore?: boolean; always?: boolean };
type ListPending = { kind: "list"; title: string; placeholder: string; items: ChoiceItem[]; inline: boolean; resolve: (id: string | null) => void };
type TextPending = { kind: "text"; title: string; placeholder: string; hint: (value: string) => string | null; resolve: (value: string | null) => void };
type Pending = ListPending | TextPending;
const pending = new Map<string, Pending>();

export function openChoice(options: { title: string; placeholder: string; items: ChoiceItem[]; inline?: boolean }): Promise<string | null> {
  const id = choiceId();
  return new Promise((resolve) => {
    pending.set(id, { kind: "list", ...options, inline: options.inline === true, resolve });
    setState({ overlay: { kind: "choice", id } });
  });
}

export function openTextPrompt(options: { title: string; placeholder: string; hint?: (value: string) => string | null }): Promise<string | null> {
  const id = choiceId();
  return new Promise((resolve) => {
    pending.set(id, { kind: "text", title: options.title, placeholder: options.placeholder, hint: options.hint ?? (() => null), resolve });
    setState({ overlay: { kind: "choice", id } });
  });
}

const choiceId = () => `choice-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
  useEffect(() => () => answer(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!entry) return null;
  if (entry.kind === "text") return <TextPrompt title={entry.title} placeholder={entry.placeholder} hint={entry.hint} onDone={answer} />;
  return <ChoiceList title={entry.title} placeholder={entry.placeholder} items={entry.items} inline={entry.inline} onChoose={answer} />;
}

function TextPrompt({ title, placeholder, hint, onDone }: { title: string; placeholder: string; hint: (value: string) => string | null; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState("");
  const note = hint(value);
  return (
    <Palette
      quickpick
      title={title}
      label={title}
      placeholder={placeholder}
      query={value}
      onQuery={setValue}
      onClose={() => onDone(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing && value.trim()) onDone(value.trim());
      }}
      footer={note}
    >
      {null}
    </Palette>
  );
}

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

function ChoiceList({ title, placeholder, items, busy = false, inline = false, onChoose }: { title: string; placeholder: string; items: ChoiceItem[]; busy?: boolean; inline?: boolean; onChoose: (id: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matched = new Set(filterDevices(items.map((i) => ({ deviceId: i.id, label: i.label, detail: i.detail })), query).map((d) => d.deviceId));
  const rows = items.filter((item) => item.always || matched.has(item.id)).map((item) => ({ ...item, deviceId: item.id }));
  const active = Math.min(index, Math.max(rows.length - 1, 0));
  return (
    <Palette
      quickpick
      title={inline ? null : title}
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
        <Fragment key={row.deviceId}>
          {row.separatorBefore && i > 0 && <div className="quickpick-separator" role="separator" />}
          <button type="button" className="quickpick-row" data-choice-option data-inline={inline || undefined} data-active={i === active || undefined} onClick={() => onChoose(row.deviceId)}>
            {row.icon && <Codicon name={row.icon} size={14} />}
            <span className="quickpick-text">
              <span className="quickpick-title">{row.label}</span>
              {row.detail && <span className="quickpick-detail faint">{row.detail}</span>}
            </span>
          </button>
        </Fragment>
      ))}
    </Palette>
  );
}
