import { useEffect, useState } from "react";
import { refreshFileList } from "./editorDocs";
import { invalidateFileRefs } from "./fileRefMark";
import { Codicon } from "./icons";
import { forgetSuggestedCode, peekSuggestedCode } from "./missingFileCode";
import { MF } from "./missingFileStrings";
import { rpc } from "./rpc";
import { Button } from "./ui/button";
import { onWorkspaceChanged } from "./workspaceEvents";

export function MissingFile({ workspaceId, path, onCreated }: { workspaceId: string; path: string; onCreated: () => void }) {
  const code = peekSuggestedCode(workspaceId, path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onWorkspaceChanged(workspaceId, () => {
        void rpc.call("files.stat", { workspaceId, path }).then(
          (r) => {
            if (r.mtimeMs !== null) onCreated();
          },
          () => undefined,
        );
      }),
    [workspaceId, path, onCreated],
  );

  const create = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("files.create", { workspaceId, path, kind: "file", text });
    } catch (e) {
      const exists = await rpc.call("files.stat", { workspaceId, path }).then((r) => r.mtimeMs !== null, () => false);
      if (!exists) {
        setError(MF.createFailed((e as Error).message));
        setBusy(false);
        return;
      }
    }
    forgetSuggestedCode(workspaceId, path);
    invalidateFileRefs(workspaceId);
    await refreshFileList(workspaceId).catch(() => undefined);
    setBusy(false);
    onCreated();
  };

  return (
    <div className="file-preview file-preview-binary file-missing" data-testid="missing-file">
      <Codicon name="new-file" size={32} className="file-preview-glyph" />
      <div className="file-preview-title">
        <code className="file-missing-path">{path}</code> {MF.title}
      </div>
      <div className="file-missing-actions">
        {code !== null && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void create(code)}>
            {MF.createWithCode}
          </Button>
        )}
        <Button size="sm" variant={code === null ? "primary" : "secondary"} disabled={busy} onClick={() => void create("")}>
          {MF.create}
        </Button>
      </div>
      {error && <div className="file-preview-note file-missing-error">{error}</div>}
    </div>
  );
}
