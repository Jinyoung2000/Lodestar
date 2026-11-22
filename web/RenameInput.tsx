import { useLayoutEffect, useRef, useState } from "react";
import type { Agent } from "../shared/protocol";
import { renameSession } from "./sessionActions";
import { stopRename } from "./sessionListState";
import { S } from "./strings";

export function RenameInput({ agent }: { agent: Agent }) {
  const [value, setValue] = useState(agent.title);
  const finished = useRef(false);
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
