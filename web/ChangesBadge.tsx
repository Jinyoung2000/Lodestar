import { defaultChangeScope } from "../shared/protocol";
import { isGeneratedPath } from "../shared/generatedFiles";
import { activeAgentOf } from "./activeAgentOf";
import { countBadge } from "./countBadge";
import { pickChanges, useChangesView } from "./changesState";
import { inFolder, useStore } from "./store";
import { S } from "./strings";
import { useWorkspaceChanges } from "./workspaceChanges";

export function ChangesBadge() {
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const draftWorkspaceId = useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane?.kind === "draft" && pane.workspaceId ? pane.workspaceId : null;
  });
  const folderAgent = agent && inFolder(agent) ? agent : null;
  const gitChanges = useStore((s) => (folderAgent ? s.gitChanges[folderAgent.id] : undefined));
  const scope = useChangesView((s) => (folderAgent ? (s.scope[folderAgent.id] ?? defaultChangeScope(folderAgent)) : "branch"));
  const scoped = useChangesView((s) => (folderAgent ? s.scoped[folderAgent.id] : undefined));
  const showOutside = useChangesView((s) => (folderAgent ? s.showOutside[folderAgent.id] === true : false));
  const draftFiles = useWorkspaceChanges(folderAgent ? null : draftWorkspaceId);
  const count = folderAgent ? (pickChanges(folderAgent, scope, showOutside, scoped, gitChanges)?.files.filter((f) => !isGeneratedPath(f.path)).length ?? 0) : (draftFiles?.filter((f) => !isGeneratedPath(f.path)).length ?? 0);
  const text = countBadge(count);
  if (!text) return null;
  return (
    <span className="tab-badge" role="status" aria-label={S.changesBadgeAria(count)} title={S.changesBadgeAria(count)}>
      {text}
    </span>
  );
}
