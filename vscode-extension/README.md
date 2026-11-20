# Lodestar for VS Code

Shows the Lodestar sessions of the folder open in VS Code and lets you continue them in a side bar chat. The Lodestar app keeps the sessions; the extension connects to its local daemon and displays them. The app and the extension can show the same session at the same time.

Lodestar is an independent project and is not affiliated with Microsoft or Anthropic.

## What it does

- The Lodestar icon in the Activity Bar opens two views. `Sessions` lists the sessions of the open folder (worktrees included) with their live status: running, waiting for approval, unread, failed. `Chat` shows the selected conversation.
- Selecting a session or pressing `New Session` opens the conversation in `Chat` and focuses the input. Sending, stopping, queued messages, approval cards and checkpoints work as in the app.
- File links in a conversation open that line in the VS Code editor. Change chips open a VS Code diff.
- `Open in Editor Tab` moves the conversation to an editor tab. `Open in Lodestar app` shows the session in the app window.
- `Lodestar: Add Selection to Session` in the editor context menu attaches the selected lines, with the file path and line range, to the open session's input.
- The `Chat` view can be dragged to the secondary side bar.
- The views follow the VS Code color theme.

## Install

Install the Lodestar app first and keep it running. Then install the `.vsix` from the release:

```bash
code --install-extension lodestar-vscode-0.1.0.vsix --force
```

Run `Developer: Reload Window` in VS Code windows that were already open.

To build it yourself:

```bash
cd vscode-extension
npm install
npm run package
```

### Agents window

The VS Code agents window loads no extensions by default. Add the extension id to your user settings yourself; the extension does not change settings.

```json
"extensions.supportAgentsWindow": ["lodestar.lodestar"]
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `lodestar.port` | 7788 | Daemon port on 127.0.0.1 |
| `lodestar.home` | empty | Folder that holds the access token. Empty uses `$AGENT_NAV_HOME`, then `~/.agent-nav` |
| `lodestar.openSessionIn` | `sidebar` | Where a selected or new session opens: `sidebar` (the Chat view) or `editor` (an editor tab) |

## How it connects

- The extension host reads `<home>/token` and connects to `ws://127.0.0.1:<port>/ws/rpc`. The token authenticates the connection; the daemon rejects a wrong one. Nothing leaves your computer.
- The conversation is the app's own session screen in an iframe served by the daemon at `http://127.0.0.1:<port>/?embed=session`. When the app is not running, the `Sessions` view says so and offers `Open Lodestar`.
- `New Session` registers the open folder with Lodestar when it is not registered yet. Only the exact folder counts as the same folder.
