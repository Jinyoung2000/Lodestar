import { useEffect, useMemo } from "react";
import type { Harness } from "../shared/protocol";
import type { Trigger } from "./composerState";
import { rankFiles } from "./fileSearch";
import { FileTypeIcon } from "./FileTypeIcon";
import { Codicon } from "./icons";
import { notionPins, useNotion } from "./notionStore";
import { N } from "./notionStrings";
import { Popup } from "./Popup";
import { ensureFiles, refreshLocalCommands, useStore } from "./store";
import { S } from "./strings";

export type TriggerItem =
  | { key: string; kind: "command"; name: string; description: string }
  | { key: string; kind: "file"; path: string }
  | { key: string; kind: "notion"; title: string; url: string };

export function useTriggerItems(trigger: Trigger | null, workspaceId: string | null, hasSession: boolean, harness: Harness = "claude"): TriggerItem[] {
  const claudeCommands = useStore((s) => s.meta?.commands);
  const commands = harness !== "claude" ? undefined : claudeCommands;
  const files = useStore((s) => (workspaceId ? s.files[workspaceId] : undefined));
  const claudeLocal = useStore((s) => (workspaceId ? s.localCommands[workspaceId] : undefined));
  const local = harness !== "claude" ? undefined : claudeLocal;
  const kind = trigger?.kind;
  const pins = useNotion((s) => s.pins);
  useEffect(() => {
    if (kind === "mention" && workspaceId) void ensureFiles(workspaceId);
    if (kind === "slash" && workspaceId) refreshLocalCommands(workspaceId);
  }, [kind, workspaceId]);
  const query = trigger?.query ?? "";
  const atStart = (trigger?.start ?? 0) === 0;
  return useMemo(() => {
    if (kind === "slash") {
      const own = !atStart ? [] : [
        ...(hasSession ? [{ name: "rename", description: S.slashRenameDescription }] : []),
        ...(hasSession && harness === "claude" ? [{ name: "btw", description: S.slashBtwDescription }] : []),
      ];
      const known = [...own, ...(commands ?? [])];
      const cli = [...(commands ?? []), ...(local ?? []).filter((c) => !known.some((k) => k.name === c.name))].filter((c) => c.name !== "rename" && !own.some((o) => o.name === c.name));
      const q = query.toLowerCase();
      const matches = [...own, ...cli].filter((c) => c.name.toLowerCase().includes(q));
      matches.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
      return matches.slice(0, 50).map((c) => ({ key: `/${c.name}`, kind: "command" as const, name: c.name, description: c.description }));
    }
    if (kind === "mention") {
      const q = query.toLowerCase();
      const notion = q ? notionPins().filter((p) => p.title.toLowerCase().includes(q)).slice(0, 5).map((p): TriggerItem => ({ key: `@notion:${p.id}`, kind: "notion", title: p.title, url: p.url })) : [];
      return [...notion, ...rankFiles(files ?? [], query, 50).map((path): TriggerItem => ({ key: `@${path}`, kind: "file", path }))];
    }
    return [];
  }, [kind, query, atStart, commands, local, files, hasSession, pins, harness]);
}

export function TriggerMenu({ trigger, items, index, anchor, onIndex, onChoose, onClose }: { trigger: Trigger; items: TriggerItem[]; index: number; anchor: HTMLElement | null; onIndex: (i: number) => void; onChoose: (item: TriggerItem) => void; onClose: () => void }) {
  return (
    <Popup anchor={anchor} placement="above" matchWidth closeOnEscape={false} label={trigger.kind === "slash" ? S.slashRenameDescription : S.attachFiles} className="popup-trigger" onClose={onClose}>
      <div className="popup-list" role="listbox">
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === index}
            className="popup-row"
            data-active={i === index || undefined}
            ref={(el) => {
              if (el && i === index) el.scrollIntoView({ block: "nearest" });
            }}
            onMouseEnter={() => onIndex(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(item)}
          >
            {item.kind === "command" ? (
              <>
                <span className="popup-command">/{item.name}</span>
                <span className="popup-row-detail">{item.description}</span>
              </>
            ) : item.kind === "notion" ? (
              <>
                <Codicon name="file" />
                <span className="popup-row-title">{item.title}</span>
                <span className="popup-row-detail">{N.mentionDetail}</span>
              </>
            ) : (
              <>
                <FileTypeIcon name={item.path.slice(item.path.lastIndexOf("/") + 1)} />
                <span className="popup-row-title">{item.path.slice(item.path.lastIndexOf("/") + 1)}</span>
                <span className="popup-row-detail">{item.path}</span>
              </>
            )}
          </button>
        ))}
        {items.length === 0 && <div className="popup-empty">{trigger.kind === "slash" ? S.slashEmpty : S.mentionEmpty}</div>}
      </div>
    </Popup>
  );
}
