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

// 입력창 위로 열리는 `/` 와 `@` 목록(B3-11). 포커스는 입력창에 남고, 위아래 선택과 Enter 는 Composer 가 받아서 이 목록의 항목을 고른다.
export type TriggerItem =
  | { key: string; kind: "command"; name: string; description: string }
  | { key: string; kind: "file"; path: string }
  // NOTION: 고르면 글에서 `@검색어` 를 지우고 그 페이지 본문을 칩으로 붙인다.
  | { key: string; kind: "notion"; title: string; url: string };

export function useTriggerItems(trigger: Trigger | null, workspaceId: string | null, hasSession: boolean, harness: Harness = "claude"): TriggerItem[] {
  // CODEX: Claude 의 스킬과 명령은 Codex 세션에서 동작하지 않으므로 / 목록에서 뺀다. rename 은 Lodestar 가 처리해서 남는다.
  const claudeCommands = useStore((s) => s.meta?.commands);
  const commands = harness === "codex" ? undefined : claudeCommands;
  const files = useStore((s) => (workspaceId ? s.files[workspaceId] : undefined));
  const claudeLocal = useStore((s) => (workspaceId ? s.localCommands[workspaceId] : undefined));
  const local = harness === "codex" ? undefined : claudeLocal;
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
      // rename 과 btw 는 메시지 맨 앞에서만 동작하므로 문장 중간의 `/` 목록에는 넣지 않는다
      const own = !atStart ? [] : [
        ...(hasSession ? [{ name: "rename", description: S.slashRenameDescription }] : []),
        ...(hasSession && harness === "claude" ? [{ name: "btw", description: S.slashBtwDescription }] : []),
      ];
      const known = [...own, ...(commands ?? [])];
      const cli = [...(commands ?? []), ...(local ?? []).filter((c) => !known.some((k) => k.name === c.name))].filter((c) => c.name !== "rename" && !own.some((o) => o.name === c.name));
      const q = query.toLowerCase();
      const matches = [...own, ...cli].filter((c) => c.name.toLowerCase().includes(q));
      // 이름이 입력으로 시작하는 것을 앞에 둔다. 같은 그룹 안의 순서는 그대로.
      matches.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
      return matches.slice(0, 50).map((c) => ({ key: `/${c.name}`, kind: "command" as const, name: c.name, description: c.description }));
    }
    if (kind === "mention") {
      // 고정한 Notion 페이지는 이름에 검색어가 든 것만, 파일 앞에 둔다(검색어가 없으면 파일만 보인다)
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
            // 입력창이 포커스를 잃지 않게 한다
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
