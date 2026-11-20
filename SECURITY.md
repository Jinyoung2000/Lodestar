# Security

## Reporting a problem

Please report security problems privately through GitHub's "Report a vulnerability" button on this repository (private vulnerability reporting). Do not open a public issue for them. Include the version or commit, what an attacker needs (local user, web page in a browser, device on the same network), the steps, and what they gain.

This is a personal project maintained in spare time. Reports are read, but there is no response-time commitment and no bug bounty.

## Trust model

Lodestar runs entirely on your Mac and acts with your user account's permissions.

- **The daemon** (`server/`) listens on `127.0.0.1` (default port 7788). A WebSocket connection is accepted only when the `Host` header is `127.0.0.1:<port>` or `localhost:<port>`, the `Origin` is the daemon itself or the local Vite dev server (port 5173), and the request carries the token from `<data folder>/token`. The daemon writes that token into the `index.html` it serves. Web pages from other origins cannot read that response, but any program running on the Mac, under any user account, can request the page from the loopback port and read the token. Lodestar therefore assumes that every local process is trusted; do not run it on a Mac shared with people you do not trust.
- **Whoever holds the token controls your machine** to the extent your account does: it can start Claude Code sessions in any permission mode (including ones that skip permission prompts), open shells, read and write files in registered workspaces, and run git and `gh` with your credentials. The token file and the data folder (`~/.agent-nav` by default) should stay readable only by you.
- **Model access** goes through the Claude Code CLI and its own sign-in. Lodestar never asks for or stores an Anthropic API key. Provider environment variables are removed from the CLI's environment unless the user turns on "Use API credentials from the environment", and it must not switch billing on its own. Sessions inherit your `~/.claude` settings, hooks, MCP servers and allow lists, so anything those allow, Lodestar sessions allow too.
- **Phone access** is off by default. When turned on, a separate server listens on all network interfaces at the daemon port + 1. It accepts only paired devices: pairing needs a one-time 8-character code that expires after 5 minutes and locks after 5 wrong attempts, each device gets its own token, the main token is not accepted there, and only a fixed set of RPC methods is exposed. Traffic is unencrypted HTTP and WebSocket; use it only on a trusted network or a VPN.
- **The Electron window** stays on the daemon's own origin. Links to other sites open in your default browser, and only `http`, `https`, `mailto`, `slack` and `notion` links (plus `file:` links to document types) are handed to the system.
- **GitHub writes** (comments, reviews, merges, pushes) are only sent after an explicit click; the daemon rejects PR write requests without a confirmation flag.
- **Agent output** shown as Markdown is sanitized with DOMPurify before rendering.
- **Code inside an opened folder** (its own TypeScript server or native `tsc`, Relay compiler, Prettier, oxfmt or ESLint and their config files, and executable paths in its `.vscode/settings.json`) runs only for workspaces you added yourself and their worktrees: adding a workspace is the trust decision. For a folder you did not add, namely a repository Lodestar cloned into `~/Repository` on its own or a pull request checkout made from the PR view (including worktrees made from it), the editor uses only the TypeScript server bundled with the app, starts no Relay server, runs no formatter except TypeScript, and does not read that folder's `.vscode/settings.json`; adding or opening that exact folder as a workspace makes it trusted.

## In scope

- Ways for a web page or a device on the network to reach the daemon or the phone server without the token or a paired device token. (Local processes can already read the token from the served page; see the trust model.)
- Path traversal or writes outside the folders the daemon is supposed to touch.
- Token or device-token leaks (logs, URLs sent to third parties, files with loose permissions).
- Any path where Lodestar passes an API key or provider switch to the CLI while "Use API credentials from the environment" is off, or stores a key.
- Command injection through file names, branch names, URLs or simulator links.

## Out of scope

- Actions a Claude or Codex session takes because you allowed them, or because you chose a permission mode that skips prompts.
- Attacks that already require running code as your user or reading your home folder.
- Behavior of Claude Code, the Codex CLI, `gh` or MCP servers themselves; report those to their maintainers.
