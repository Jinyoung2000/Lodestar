import { useState } from "react";
import { S } from "./strings";
import { addWorkspaceByPath } from "./workspaceActions";

export type WorkspacePathInputProps = { className: string; onAdded?: () => void; onCancel: () => void };

export function WorkspacePathInput({ className, onAdded, onCancel }: WorkspacePathInputProps) {
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!dir.trim()) return;
    try {
      await addWorkspaceByPath(dir);
      setDir("");
      setError(null);
      onAdded?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className={className}>
      <input
        className="input mono"
        aria-label={S.workspacePath}
        placeholder={S.openFolderPlaceholder}
        value={dir}
        autoFocus
        onChange={(e) => {
          setDir(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") void add();
          else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {error && <span className="xs error-text">{error}</span>}
    </div>
  );
}
