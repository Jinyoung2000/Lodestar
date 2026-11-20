import { useState } from "react";
import { S } from "./strings";
import { Button } from "./ui/button";
import { addWorkspaceByPath } from "./workspaceActions";

export type WorkspacePathInputProps = { className: string; onAdded?: () => void; onCancel: () => void };

export function WorkspacePathInput({ className, onAdded, onCancel }: WorkspacePathInputProps) {
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pickFolder = window.agentNavNative?.pickFolder;

  const add = async (path: string) => {
    if (!path.trim()) return;
    try {
      await addWorkspaceByPath(path);
      setDir("");
      setError(null);
      onAdded?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const browse = async () => {
    if (!pickFolder) return;
    try {
      const picked = await pickFolder();
      if (picked) await add(picked);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className={className}>
      <div className="workspace-path-row">
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
            if (e.key === "Enter") void add(dir);
            else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        {pickFolder && (
          <Button variant="secondary" size="default" onClick={() => void browse()}>
            {S.browseFolder}
          </Button>
        )}
      </div>
      {error && <span className="xs error-text">{error}</span>}
    </div>
  );
}
