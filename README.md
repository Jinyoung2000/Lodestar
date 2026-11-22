# Lodestar

Lodestar is a local macOS app for running many Claude Code sessions side by side, one per project or git worktree. A Node daemon drives your signed-in Claude Code CLI through the Claude Agent SDK, and an Electron window shows each conversation next to its file changes, an editor, a terminal and git tools. Nothing is hosted: the daemon, its data and the UI all stay on your Mac.

This is a personal project published as-is. It is developed and used on macOS with Apple Silicon, and many defaults follow the author's own setup (VS Code settings, Claude Code configuration, folder layout).

## Features

- Session grid: several conversations open at once, each in its own folder or git worktree, with queued and interrupting messages, permission prompts, checkpoints, forks and a `/btw` side chat that does not change the main transcript.
- Changes panel: per-session diffs against the branch base, the session start or the last turn, with keep and undo per hunk, and line comments sent back to the session as feedback.
- Editor: CodeMirror 6 with TypeScript language-server support (definitions, references, hover, completion), formatting through the formatter your VS Code settings pick, search and replace across the workspace.
- Terminal (node-pty), Source Control view (stage, commit, push and pull with confirmation), worktree creation and cleanup.
- Pull requests through the GitHub CLI: lists, an overview, file diffs, review comments and checkout into a worktree.
- Optional integrations that reuse what your Claude Code already has: a read-only Slack inbox and Notion pages through your configured MCP servers, a Linear panel with a personal API key kept in the macOS keychain, and a local kanban board.
- Optional Codex and Antigravity sessions when the Codex CLI or the Antigravity CLI (`agy`) is installed and signed in, and switching a session between Claude, Codex and Antigravity.
- Import of Claude sessions from the VS Code agent window (read-only access to VS Code's state).
- A phone client (`mobile/`, Expo) that pairs with the daemon over the local network, a VS Code extension (`vscode-extension/`) that shows Lodestar sessions inside VS Code, and a small CLI (`bin/lodestar.mjs`) that opens folders and files in the app (`lodestar <path>[:line[:column]]`) and lists and messages sessions.

A detailed feature reference, written in Korean during development, is in [docs/FEATURES.ko.md](docs/FEATURES.ko.md). It can lag behind the code.

## Requirements

- macOS. The daemon and app call macOS tools (`/usr/bin/security`, `/usr/bin/sqlite3`, `open`, `osascript`, `xcrun`), and `npm run dist` is set up for Apple Silicon (it signs `release/mac-arm64/Lodestar.app`). Other platforms are not supported.
- Node.js 22.12 or newer (Vite and oxlint need it; the bundled `typescript-language-server` declares 22.22.2 or newer) and npm.
- Claude Code CLI installed (`~/.local/bin/claude`, anywhere on your login shell `PATH`, or the path in `AGENT_NAV_CLAUDE`) and signed in (`claude auth login`). Lodestar runs that CLI unmodified and uses the account it is signed in to; it never asks for, reads or stores a key.
- Optional: `gh` signed in, for pull requests and checks. Optional: the Codex CLI at `~/.local/bin/codex` (or `AGENT_NAV_CODEX`), for Codex sessions. Optional: the Antigravity CLI `agy` at `~/.local/bin/agy` (or `AGENT_NAV_ANTIGRAVITY`), signed in, for Antigravity sessions. Optional: Xcode command line tools, for the simulator link actions.

## Install

### Download (Apple Silicon)

1. Download `Lodestar-<version>-mac-arm64.zip` from [Releases](https://github.com/Jinyoung2000/Lodestar/releases/latest), unzip it and move `Lodestar.app` to `/Applications`.
2. The build is ad-hoc signed and not notarized, so macOS blocks the first launch. Clear the download flag once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Lodestar.app
   ```

3. Install Claude Code and sign in (`claude auth login`), then open Lodestar.

The downloaded app needs no Node.js. Node is required only to build from source.

### VS Code extension

If you work in VS Code, install `lodestar-vscode-<version>.vsix` from the same release (`code --install-extension lodestar-vscode-<version>.vsix`). It lists the sessions of the folder open in VS Code and shows the conversation in a side bar view, backed by the running Lodestar app. This is the recommended way to use Lodestar next to VS Code; the app's own editor-centered layout is optional (Settings, "Default layout").

### From source

```bash
git clone https://github.com/Jinyoung2000/Lodestar.git agent-nav
cd agent-nav
npm ci
```

## Run

Build once, then start the Electron app. The app starts the daemon for you.

```bash
npm run build   # web UI to dist/, Electron and daemon bundles to dist-electron/
npm run app     # Electron window plus daemon on 127.0.0.1:7788
```

To use a browser instead of the Electron window, run only the daemon and open `http://127.0.0.1:7788`. It serves the web build from `dist/`, so run `npm run build` (or `npm run build:web`) first.

```bash
npm start
```

For UI development, `npm run dev` runs the daemon under `tsx watch` and the Vite dev server on port 5173 together.

Only one daemon can own a data folder. If the installed app is already running on 7788, start your development copy with its own folder and port:

```bash
AGENT_NAV_HOME=/tmp/lodestar-dev AGENT_NAV_PORT=7801 npm start
```

Environment variables that matter:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_NAV_PORT` | `7788` | Daemon port on 127.0.0.1 |
| `AGENT_NAV_HOME` | `~/.agent-nav` | Data folder: settings, sessions index, board, logs, the access token |
| `AGENT_NAV_CLAUDE` | `~/.local/bin/claude`, then `claude` on `PATH` | Claude Code CLI to run |
| `AGENT_NAV_CODEX` | `~/.local/bin/codex` | Codex CLI to run |
| `AGENT_NAV_ANTIGRAVITY` | `~/.local/bin/agy`, then `agy` on `PATH` | Antigravity CLI to run; point it at a fake `agy` for tests and checking instances |
| `AGENT_NAV_GH` | `gh` on `PATH` | GitHub CLI to run |
| `AGENT_NAV_SRC` | `~/Repository/agent-nav` when the app is installed | Source folder that the self-improvement and idle-update features build from |
| `AGENT_NAV_MOBILE_PORT` | daemon port + 1 | Port for the phone client, only opened when phone access is turned on |

## Build and package

```bash
npm run build   # also regenerates design tokens and runs the hooks lint first
npm run dist    # release/mac-arm64/Lodestar.app, ad-hoc signed, not notarized
```

`npm run tokens` regenerates `web/tokens.css` from `design-system/tokens.json`. `npm run icon` rebuilds the app icon from `build/icon.svg`.

The phone client and the VS Code extension have their own `package.json`; see `mobile/package.json` (`npm start`, `npm test`) and [vscode-extension/README.md](vscode-extension/README.md).

### Android companion

The signed ARM64 build uses the application ID `com.utillo.lodestar`. From `mobile/`, run `npm ci` and `sh scripts/build-android.sh`. Install `dist/lodestar-android.apk` on the phone. Keep the private `.signing/` directory for subsequent APK upgrades.

In Lodestar on the Mac, enable **Settings → Mobile access** and create a pairing code. Scan the QR code on the phone or enter the address and code. On the same Wi-Fi, use the Mac's LAN address. For private access away from home, connect both devices to the same Tailscale network and enter the Mac's Tailscale IP with the mobile port (default 7789).

The phone also accepts an explicit HTTPS address such as `https://mac.example-tailnet.ts.net`. To use an existing Tailscale reverse proxy, forward it to the mobile listener on `127.0.0.1:7789`. Start the daemon with `AGENT_NAV_MOBILE_BIND=127.0.0.1` and `AGENT_NAV_MOBILE_ALLOW_ORIGIN=https://mac.example-tailnet.ts.net`, substituting the actual HTTPS origin (including a non-default port). Pair using that HTTPS address and the one-time code. Tailscale Serve requires tailnet access on the phone. Tailscale Funnel makes the mobile pairing and device-authenticated endpoints reachable from the public internet. Forward only the mobile port.

**Waiting** shows sessions that need a reply. To follow running sessions while using another Android app, turn on **Settings → Notifications → Session alerts**. The phone connects directly to the paired Mac, shows ongoing activity, and posts a notification for questions, errors and finished turns. Tap a notification to return to the session. Reopen Lodestar after force-stopping it or restarting the phone to resume alerts.

Open **Previews → New preview** in a session to request a prototype, diagram, document or table. The phone renders named `lodestar-preview` or `html`, `svg`, `markdown` and `csv` blocks directly from the reply. The same gallery includes images, tool screenshots and supported workspace files linked or changed in the conversation. HTML supports embedded images, CSS and scripts. Original images and workspace file reads require a Mac build with `mobile.preview`. File previews support up to 5 MB, or 256 KB for SVG, Markdown and CSV. CSV shows up to 200 rows and 40 columns.

**Over-the-air updates.** The Android build checks the EAS Update `production` channel at launch. Downloaded changes take effect on the next launch. **Settings → App updates → Check for update** can download and apply an update immediately. To publish compatible JavaScript and asset changes from `mobile/`, run `npm run update:android -- --message "Describe the change"` using an EAS CLI signed in to the Lodestar project. For native module, SDK or native configuration changes, increment `expo.version` and `android.versionCode` before building the next APK. The Android runtime version follows `expo.version`.

## Tests and checks

```bash
npm run typecheck    # tsc over server, shared, web, electron and test
npm run lint:tokens  # design-token lint for web/
npm run lint:hooks   # oxlint React hooks rule for web/
npm test             # both lints, then every test script in order
```

Tests are plain `tsx` scripts in `test/` that print `ok` or `FAIL` per check and exit non-zero on failure. They use fakes for the Claude CLI, `gh`, Codex, the keychain and `xcrun`. Tests that need a daemon start their own on a temporary data folder and a free port, and refuse to target port 7788 or `~/.agent-nav`. The phone client's tests run with `npm test` inside `mobile/`.

## Security model

- The main daemon listens on `127.0.0.1` only. Every WebSocket connection must pass three checks: the `Host` header is `127.0.0.1:<port>` or `localhost:<port>` (against DNS rebinding), the `Origin` is the daemon itself or the local Vite dev server, and the query carries the random token stored in `<data folder>/token`, which the daemon writes into the page it serves.
- Anyone who can reach that port with the token can do what you can do: the daemon runs Claude Code sessions with your permissions, opens shells in your folders, reads and writes files in the workspaces you add, runs git and `gh`, and starts sessions in whatever permission mode you choose, including modes that skip prompts. Treat the token like a password. Note that any local program (under any account on the Mac) can read it by requesting the daemon's page, so Lodestar trusts every local process.
- Model calls go through the Claude Code CLI and its own login. Lodestar does not read or store an Anthropic API key. By default it removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches from the environment it gives the CLI, so sessions use the CLI's own sign-in. Turn on Settings, "Use API credentials from the environment" to pass them through; usage is then billed to that key or provider. Sessions use your `~/.claude` settings, hooks, MCP servers and allow lists.
- Phone access ("Mobile access" in Settings) is off by default. When you turn it on, a second, separate server listens on all interfaces (port + 1). It accepts only devices paired with a one-time code (8 characters, valid for 5 minutes, locked after 5 wrong tries), each device gets its own token, and only a fixed list of RPC methods is allowed. The connection is plain HTTP and WebSocket, so use it only on a network you trust or over a VPN such as Tailscale.
- Writes to GitHub (comments, reviews, merges, pushes) happen only when you press the button; the daemon rejects PR write requests that are not marked as confirmed.
- Adding a workspace is the trust decision for code inside it. The editor runs a folder's own TypeScript, Relay compiler and formatters (and executable paths from its `.vscode/settings.json`) only in workspaces you added and their worktrees. In a repository Lodestar cloned on its own or in a pull request checkout made from the PR view, it uses only the bundled TypeScript server, starts no Relay server, runs no formatter except TypeScript and ignores that folder's `.vscode/settings.json`, until you add or open that folder yourself.
- Behavior to be aware of: when a session reads a file from a GitHub repository (with `gh api` or a `github.com/.../blob/...` link), the daemon clones that repository into `~/Repository/<name>` with `gh` and fast-forwards it every 30 minutes; there is no setting for this yet. The installed app also has an idle self-update ("Update when idle" in Settings, off by default) that rebuilds from `AGENT_NAV_SRC` when that folder exists and can replace `/Applications/Lodestar.app`; when that folder already has a build (`dist/` and `dist-electron/daemon.mjs`), the installed app runs its daemon and UI from there, and the in-app feedback feature lets a session edit Lodestar's own source in a separate worktree.
- Lodestar itself contacts the network in one case only, and it is off by default: with "New version available" turned on in Settings, the daemon asks the GitHub releases API for the latest Lodestar release at most once a day, without credentials, and shows a row in the sidebar when it is newer. Nothing is downloaded or installed. "Report on GitHub…" in the feedback window sends nothing by itself: it opens a prefilled new-issue page in your browser, where you review and submit; the screenshot and file paths are left out unless you check them.

See [SECURITY.md](SECURITY.md) for how to report a problem.

## Project layout

| Path | What it is |
| --- | --- |
| `server/` | Daemon: HTTP and WebSocket server (`index.ts`), Claude and Codex session runners, git, PRs, LSP bridge, terminal, store |
| `shared/` | Types and pure logic shared by the daemon, web UI and phone client |
| `web/` | React web UI (CodeMirror 6, xterm, Radix, Tailwind with design tokens) |
| `electron/` | Electron main process, preload scripts, quick-entry window |
| `mobile/` | Expo / React Native phone client |
| `vscode-extension/` | VS Code extension that attaches to the daemon |
| `design-system/` | Design tokens (`tokens.json`), component specs and previews |
| `scripts/` | Token build and lint, icon build, build stamp |
| `test/` | `tsx` test scripts and fixtures |
| `bin/lodestar.mjs` | CLI: `lodestar <path>[:line[:column]]` opens a folder or file in the app, `lodestar session list` lists sessions, and `lodestar session move <folder>` moves a chat without a folder into that folder. Link it onto your `PATH`, for example `ln -s "$PWD/bin/lodestar.mjs" ~/.local/bin/lodestar` |
| `docs/` | Feature reference |

## Naming

The repository and npm package are called `agent-nav`; the app is called Lodestar. The data folder (`~/.agent-nav`), the environment variables (`AGENT_NAV_*`) and the macOS bundle id still use the old name.

## License

MIT. See [LICENSE](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Claude Agent SDK is not open source; its use is governed by Anthropic's terms.

Lodestar is an independent project. It is not affiliated with, sponsored by or endorsed by Microsoft, Anthropic, OpenAI or JetBrains. Its interface follows the layout of Visual Studio Code and reuses values and strings from the MIT-licensed `microsoft/vscode` repository; the notice and the trademark statement are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
