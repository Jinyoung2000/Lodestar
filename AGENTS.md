# Instructions for coding agents

Lodestar (repository and package name `agent-nav`) is a local macOS app: a Node daemon in `server/`, an Electron shell in `electron/`, a React web UI in `web/`, an Expo phone client in `mobile/`, shared types in `shared/`, a VS Code extension in `vscode-extension/`. Read [README.md](README.md) for the overview and [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the rules that must not change; they apply here in full.

## Commands

- `npm run typecheck` type check
- `npm run lint:tokens` design-token lint, `npm run lint:hooks` React hooks lint (oxlint)
- `npm test` both lints, then every `tsx` test script listed in `package.json`
- `npm run build` web build to `dist/`, bundles to `dist-electron/`; `npm run build:web` web only
- `npm start` daemon only, `npm run dev` daemon plus Vite, `npm run app` Electron window
- Inside `mobile/`: `npm run typecheck`, `npm test`. Inside `vscode-extension/`: `npm run typecheck`, `npm run check`

Run typecheck, both lints and the tests that cover your change before reporting it as done.

## Where things live

- HTTP and WebSocket server, auth checks, RPC handlers: `server/index.ts`
- Claude sessions: `server/agents.ts`, CLI environment: `server/claude.ts`; Codex sessions: `server/codex/`
- Persistence and settings defaults: `server/store.ts`; RPC and settings types: `shared/protocol.ts`
- Phone pairing and its separate server: `server/mobileAccess.ts`, `shared/mobile.ts`
- Desktop link (one Mac opening another): `server/desktopLink.ts`, `server/desktopLinkHost.ts`, `shared/desktopLink.ts`; the window side is `web/remote.ts`
- UI strings: `web/strings.ts`; design tokens: `design-system/tokens.json`
- Test daemon helper: `test/testDaemon.ts`; fakes: `test/fixtures/`

## Isolation

- Any daemon or app you start for testing must use its own data folder and port: set both `AGENT_NAV_HOME` (a temporary folder) and `AGENT_NAV_PORT` (not 7788). `useTestDaemon()` does this for tests.
- Never quit, restart or rebuild the installed Lodestar app, never stop a daemon you did not start, and never read or change `~/.agent-nav`.
- The installed app can rebuild from `~/Repository/agent-nav` when idle (`AGENT_NAV_SRC`, Settings "Update when idle"; off by default, on in builds from before that default changed). It finds new source with `git ls-files`, so the folder must be a git repository for it to act. Do not leave half-finished changes in that folder while an app with the setting on is running; work in a worktree instead.
- Do not run `npm run dist` or the packaging steps unless asked.

## Commits

- Commit each unit of work as soon as it is done and its checks pass, before reporting it or starting the next one. A fix, a feature or a rule change is one commit; do not leave finished work uncommitted in the working tree. You do not need to ask first. Do not push unless asked.
- Several sessions work in this folder at once, so the working tree often holds other sessions' unfinished edits, sometimes in the same files as yours. Stage only your own changes: add whole files by path when they are yours alone, and for a shared file stage just your hunks (filter `git diff` to them and `git apply --cached` the patch). Never commit, stash, revert or reformat another session's changes, and check `git diff --cached` before committing.
- The message is one English sentence in the style of `git log`: what changed for the user, no type prefix, no emojis, no co-author lines.

## Rules

- Keep every listener of the main daemon on `127.0.0.1`. Sessions use the account the user's Claude Code CLI is signed in to. Provider environment variables (`ANTHROPIC_API_KEY` and the others in `server/claude.ts`) reach the CLI only when the `useProviderEnv` setting is on, which is off by default; never read, store or ask for a key, and never add another billing path. Never run provider login or logout, and never read, copy or edit provider auth files.
- English for UI copy; no emojis anywhere.
- Do not add UI render or snapshot tests. Use the fakes for the Claude CLI, `gh`, Codex, the keychain and `xcrun`; tests must not call real services.

## Checking the app on a real screen

- The installed app serves the web build and the daemon bundle from this folder's `dist/` and `dist-electron/` when they exist, so do not run `npm run build` here while it is running. Copy the source elsewhere (`rsync` without `node_modules`, `dist`, `dist-electron`, `release`; symlink `node_modules`), build in the copy and run `./node_modules/.bin/electron .` there with `AGENT_NAV_HOME`, `AGENT_NAV_PORT`, `AGENT_NAV_MOBILE_PORT`, `AGENT_NAV_USER_DATA`, `AGENT_NAV_SRC` (the copy) and `AGENT_NAV_NO_GLOBAL_SHORTCUT=1`. The daemon puts the login shell `PATH` in front of its own, so a fake on `PATH` does not win: point `AGENT_NAV_CLAUDE`, `AGENT_NAV_CODEX`, `AGENT_NAV_ANTIGRAVITY`, `AGENT_NAV_CURSOR` and `AGENT_NAV_GH` at the fakes (`test/fixtures/fake-claude.mjs`, `test/fixtures/codex/app-server.mjs`, `test/fixtures/antigravity/agy.mjs`, `test/fixtures/cursor/agent.mjs`, or a path that does not exist) so the instance never calls your real CLIs.
- Setting `AGENT_NAV_E2E_PORT` opens the test channel (`handleE2E` in `electron/main.ts`) and makes the instance invisible and inactive: it never takes focus or shows a window. Drive it with JSON posts (`eval`, `key`, `screenshot`, `quickOpen`, `quickEval`, ...). Real activation and the global shortcut cannot be exercised this way.
