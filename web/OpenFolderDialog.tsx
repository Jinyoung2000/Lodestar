import { useState } from "react";
import { rpc } from "./rpc";
import { S } from "./strings";
import { Dialog, DialogContent } from "./ui/dialog";

// Open Folder...: 사이드바의 Add Workspace 와 같은 경로 입력. 신뢰 확인은 만들지 않는다.
export function OpenFolderDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (workspaceId: string) => void }) {
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!dir.trim()) return;
    try {
      const workspace = await rpc.call("workspaces.add", { dir: dir.trim() });
      onClose();
      onOpened(workspace.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent label={S.openFolderTitle}>
        <div className="palette-input">
          <input className="input mono" autoFocus aria-label={S.openFolderTitle} placeholder={S.openFolderPlaceholder} value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void submit()} />
        </div>
        {error && <div className="palette-footer">{error}</div>}
      </DialogContent>
    </Dialog>
  );
}
