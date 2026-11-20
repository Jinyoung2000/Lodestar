import { useLayoutEffect, useRef, useState } from "react";
import type { Agent } from "../shared/protocol";
import { renameSession } from "./sessionActions";
import { stopRename } from "./sessionListState";
import { S } from "./strings";

// 이름 입력. Enter 로 확정, Esc 로 취소, 포커스를 잃으면 확정한다. 처음에 현재 제목이 전체 선택돼 있다.
export function RenameInput({ agent }: { agent: Agent }) {
  const [value, setValue] = useState(agent.title);
  const finished = useRef(false);
  // autoFocus 는 마운트 때 포커스만 주고 onFocus 를 부르지 않아 전체 선택이 안 됐다. 마운트 직후 직접 포커스하고 전체 선택한다.
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save && value.trim() && value.trim() !== agent.title) renameSession(agent.id, value);
    stopRename();
  };
  return (
    <input
      ref={inputRef}
      className="session-rename"
      aria-label={S.renameAria}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
