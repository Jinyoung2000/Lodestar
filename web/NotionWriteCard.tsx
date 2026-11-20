import { useState } from "react";
import type { NotionWritePreview } from "../shared/notionWrite";
import { ApprovalDiff } from "./ApprovalDiff";
import { Close, Codicon } from "./icons";
import { openNotionScreen } from "./notionScreen";
import { N } from "./notionStrings";
import { rpc } from "./rpc";
import { flash } from "./store";
import { Button } from "./ui/button";
import type { PermissionItem } from "./timelineModel";

// Notion 쓰기 제안(notion_update_page, notion_create_pages)의 승인 카드. 바뀔 내용을 diff 로 보여 주고, Apply to Notion 을 눌러야 데몬이 Notion 에 쓴다.
// Allow in this Session 같은 항상 허용은 없다. 매번 이 카드를 거친다.
export function NotionWriteCard({ agentId, item, preview }: { agentId: string; item: PermissionItem; preview: NotionWritePreview }) {
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const respond = (apply: boolean) => {
    void rpc.call("agents.respondNotionWrite", { agentId, itemId: item.id, apply, ...(!apply && note.trim() ? { feedback: note.trim() } : {}) }).catch((error: Error) => flash(error.message));
  };
  return (
    <div className="approval-card notion-write-card" role="group" aria-label={preview.summary}>
      <div className="approval-head">
        <span className="approval-title">{preview.summary}</span>
        <button type="button" className="icon-button" aria-label={N.writeReject} title={N.writeReject} onClick={() => respond(false)}>
          <Close />
        </button>
      </div>
      {preview.target && (
        <div className="approval-target">
          <span>{preview.kind === "create" ? N.writeParent : N.writeTarget}</span>
          {preview.target.url ? (
            <button type="button" className="code-chip notion-write-target" title={preview.target.url} onClick={() => openNotionScreen(preview.target!.url!)}>
              <Codicon name="file" size={12} />
              {preview.target.title}
            </button>
          ) : (
            <code className="code-chip">{preview.target.title}</code>
          )}
        </div>
      )}
      <NotionWriteBody preview={preview} />
      {noting && (
        <textarea className="textarea notion-write-note" aria-label={N.writeNotePlaceholder} placeholder={N.writeNotePlaceholder} rows={2} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
      )}
      <div className="approval-actions">
        <Button variant="primary" size="default" data-approval-primary onClick={() => respond(true)}>
          {N.writeApply}
        </Button>
        <Button variant="secondary" size="default" data-approval-skip onClick={() => respond(false)}>
          {noting && note.trim() ? N.writeRejectWithNote : N.writeReject}
        </Button>
        {!noting && (
          <Button variant="ghost" size="default" onClick={() => setNoting(true)}>
            {N.writeNoteToggle}
          </Button>
        )}
      </div>
      <div className="faint xs notion-write-hint">{N.writeHint}</div>
    </div>
  );
}

// 바뀔 내용: 새 페이지 목록, 경고, 속성 변경 표, 본문 diff. 승인 카드와 처리된 뒤의 대화 기록 줄(NotionWriteRow)이 같이 쓴다.
export function NotionWriteBody({ preview }: { preview: NotionWritePreview }) {
  const diff = preview.diff;
  return (
    <>
      {preview.creates && preview.creates.length > 0 && (
        <ul className="notion-write-creates" aria-label={N.writeCreates(preview.creates.length)}>
          {preview.creates.map((create, index) => (
            <li key={index}>{create.title}</li>
          ))}
        </ul>
      )}
      {preview.warnings.map((warning) => (
        <div key={warning} className="notion-write-warn" role="note">
          {warning}
        </div>
      ))}
      {preview.properties.length > 0 && (
        <table className="notion-write-props" aria-label={N.writeProperties}>
          <tbody>
            {preview.properties.map((row) => (
              <tr key={row.name}>
                <th scope="row">{row.name}</th>
                <td data-side="before">{row.before ?? <span className="faint">{N.writeEmptyValue}</span>}</td>
                <td className="notion-write-arrow" aria-hidden>
                  <Codicon name="arrow-right" size={12} />
                </td>
                <td data-side="after">{row.after ?? <span className="faint">{N.writeEmptyValue}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {diff && <ApprovalDiff preview={{ path: "notion-page.md", before: diff.before, after: diff.after, isNew: diff.before === "" }} />}
      {diff && !diff.exact && <div className="approval-message muted">{N.writeChangedPieces}</div>}
    </>
  );
}
