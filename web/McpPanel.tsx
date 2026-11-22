import { useState } from "react";
import type { McpStatus } from "../shared/protocol";
import { CLAUDE_AI_CONNECTORS_URL, isClaudeAiServer } from "../shared/mcp";
import { Refresh } from "./icons";
import { flash, refreshMeta, reconnectMcp, toggleMcp, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { hint } from "./hint";

export function McpSection() {
  const meta = useStore((s) => s.meta);
  const refreshing = useStore((s) => s.metaRefreshing);
  return (
    <div className="status-section">
      <div className="status-row">
        <span className="spacer" />
        <Button size="sm" disabled={refreshing} onClick={() => void refreshMeta()}>
          <span className={refreshing ? "spin" : "inline-flex"}>
            <Refresh size={14} />
          </span>
          {S.mcpRefreshAll}
        </Button>
      </div>
      <div className="status-row muted small mcp-scope-note">{S.mcpScopeNote}</div>
      {(meta?.mcp ?? []).map((m) => (
        <McpServerRow key={m.name} server={m} />
      ))}
      {meta && !meta.mcp.length && <div className="status-row muted small">{meta.error ? S.mcpUnavailable : meta.fetchedAt ? S.noMcpServers : S.loading}</div>}
    </div>
  );
}

function McpServerRow({ server }: { server: McpStatus }) {
  const busy = useStore((s) => s.mcpBusy[server.name]);
  const disabled = server.status === "disabled";
  return (
    <div className="mcp-server" data-testid={`mcp-${server.name}`}>
      <div className="status-row small">
        <span className="dot" data-state={busy === "reconnect" || busy === "enable" ? "pending" : server.status} />
        <span className="mono">{server.name}</span>
        <span className="spacer" />
        <span className="muted" data-testid="mcp-status">
          {server.status}
          {server.status === "connected" && typeof server.toolCount === "number" ? `, ${S.mcpTools(server.toolCount)}` : ""}
        </span>
        {!disabled && (
          <Button size="sm" disabled={!!busy} onClick={() => void reconnectMcp(server.name)}>
            <span className={busy === "reconnect" ? "spin" : "inline-flex"}>
              <Refresh size={14} />
            </span>
            {busy === "reconnect" ? S.mcpReconnecting : S.mcpReconnect}
          </Button>
        )}
        <Button size="sm" disabled={!!busy} onClick={() => void toggleMcp(server.name, disabled)}>
          {disabled ? (busy === "enable" ? S.mcpEnabling : S.mcpEnable) : busy === "disable" ? S.mcpDisabling : S.mcpDisable}
        </Button>
      </div>
      <McpDetail server={server} />
      {server.status === "connected" && (server.tools?.length ?? 0) > 0 && <McpToolList server={server} />}
    </div>
  );
}

function McpToolList({ server }: { server: McpStatus }) {
  const [open, setOpen] = useState(false);
  const tools = server.tools ?? [];
  return (
    <div className="mcp-tools small">
      <button type="button" className="mcp-tools-toggle" aria-expanded={open} data-testid={`mcp-tools-toggle-${server.name}`} onClick={() => setOpen(!open)}>
        {open ? S.mcpHideTools : S.mcpShowTools(tools.length)}
      </button>
      {open && (
        <ul className="mcp-tool-list" aria-label={server.name}>
          {tools.map((tool) => (
            <li key={tool.name} className="mcp-tool">
              <span className="mono mcp-tool-name">{tool.name}</span>
              {tool.description && (
                <span className="muted mcp-tool-desc" title={tool.description}>
                  {tool.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function McpDetail({ server }: { server: McpStatus }) {
  const note = useStore((s) => s.mcpNotes[server.name]);
  return (
    <div className="mcp-detail small">
      {server.status === "failed" && server.error && <div className="error-text">{server.error}</div>}
      {note && note.text !== server.error && (
        <div className={note.ok ? "muted" : "error-text"} data-testid="mcp-note">
          {note.text}
        </div>
      )}
      {server.status === "needs-auth" && <McpAuthHelp server={server} />}
    </div>
  );
}

function McpAuthHelp({ server }: { server: McpStatus }) {
  if (isClaudeAiServer(server)) {
    return (
      <div className="mcp-auth">
        <span className="muted">{S.mcpAuthClaudeAiHint}</span>
        <Button asChild size="sm" variant="secondary">
          <a href={CLAUDE_AI_CONNECTORS_URL} target="_blank" rel="noopener noreferrer" data-testid="mcp-auth-link">
            {S.mcpAuthClaudeAi}
          </a>
        </Button>
      </div>
    );
  }
  return (
    <div className="mcp-auth">
      <span className="muted">{S.mcpAuthLocal}</span>
      <Button size="sm" variant="secondary" data-testid="mcp-copy-command" onClick={() => void copyCommand()}>
        {S.mcpCopyCommand}
      </Button>
    </div>
  );
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText("claude");
    hint(S.mcpCopied, undefined, { check: true });
  } catch {
    flash(S.mcpCopyFailed);
  }
}
