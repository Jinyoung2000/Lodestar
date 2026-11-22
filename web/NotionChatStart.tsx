import { useState } from "react";
import { Composer } from "./Composer";
import { useDraftDefaults } from "./defaults";
import { notionPageKey } from "../shared/notionLink";
import type { FileRef } from "../shared/protocol";
import { N } from "./notionStrings";
import { rpc } from "./rpc";
import { flash, rememberPick, setState, useStore } from "./store";

export function NotionChatStart({ url }: { url: string }) {
  const paneId = `notion:${notionPageKey(url)}`;
  const draft = useDraftDefaults();
  const model = useStore((s) => s.draftModel[paneId]);
  const effort = useStore((s) => s.draftEffort[paneId]);
  const mode = useStore((s) => s.draftPermission[paneId]);
  const [starting, setStarting] = useState(false);
  const permissionMode = mode ?? draft.permissionMode;
  const chosenModel = model === undefined ? draft.model : model;
  const chosenEffort = effort === undefined ? draft.effort : effort;

  const start = async (prompt: string, images?: { id: string; label: string; thumb: string }[], files?: FileRef[]) => {
    setStarting(true);
    try {
      await rpc.call("notion.chat.start", { url, prompt, permissionMode, model: chosenModel, effort: chosenEffort, ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}) });
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="notion-chat-start">
      <div className="notion-chat-intro">
        <div className="notion-chat-intro-title">{N.chatEmptyTitle}</div>
        <div className="notion-chat-intro-body">{N.chatEmptyBody}</div>
        <div className="notion-suggestions" role="group" aria-label={N.chatTitle}>
          {SUGGESTIONS.map((item) => (
            <button key={item.label} type="button" className="chip notion-suggestion" disabled={starting} onClick={() => void start(item.prompt).catch(() => undefined)}>
              {item.label}
            </button>
          ))}
        </div>
        {starting && <div className="notion-chat-starting">{N.chatStarting}</div>}
      </div>
      <Composer
        paneId={paneId}
        agent={null}
        workspaceId={null}
        busy={starting}
        permissionMode={permissionMode}
        onPermissionMode={(next) => {
          rememberPick({ permissionMode: next });
          setState((s) => ({ draftPermission: { ...s.draftPermission, [paneId]: next } }));
        }}
        model={chosenModel}
        activeModel={null}
        effort={chosenEffort}
        onSubmit={async (prompt, options) => {
          await start(prompt, options.images, options.files);
        }}
      />
    </div>
  );
}

const SUGGESTIONS = [
  { label: N.suggestSummarize, prompt: N.suggestPromptSummarize },
  { label: N.suggestTasks, prompt: N.suggestPromptTasks },
  { label: N.suggestEdit, prompt: N.suggestPromptEdit },
  { label: N.suggestCode, prompt: N.suggestPromptCode },
];
