# Contributing

Thanks for looking. Lodestar is a personal tool published as-is, so the bar for changes is that they keep working for the author's daily use. Small, focused pull requests with a clear reason are the easiest to accept. For larger changes, open an issue first.

## Setup

Requirements are in the [README](README.md#requirements): macOS, Node.js 22.12 or newer, and for running sessions a signed-in Claude Code CLI.

```bash
npm ci
npm run build                                  # needed once so the daemon has a web build to serve
AGENT_NAV_HOME=/tmp/lodestar-dev AGENT_NAV_PORT=7801 npm start
```

Always use your own `AGENT_NAV_HOME` and `AGENT_NAV_PORT` while developing if you also run the installed app. Two daemons must never share one data folder, and a test or development instance must never take over port 7788 or `~/.agent-nav`.

`npm run dev` runs the daemon under `tsx watch` plus the Vite dev server (port 5173) for UI work.

## Checks before a pull request

```bash
npm run typecheck
npm run lint:tokens
npm run lint:hooks
npm test
```

CI runs the same commands on macOS (see `.github/workflows/ci.yml`). If you touch `mobile/`, also run `npm run typecheck` and `npm test` inside `mobile/`. If you touch `vscode-extension/`, run `npm run typecheck` and `npm run check` inside it.

For UI changes, look at the result in the running app at desktop width and in a narrow window, and include a screenshot in the pull request. A passing type check does not show that a layout works.

## Code conventions

- TypeScript in strict mode, ES modules (`"type": "module"`). Daemon code runs through `tsx` and esbuild, so relative imports have no file extension.
- Exact versions in `package.json`; do not add a dependency without a reason in the pull request.
- Types and pure logic used by more than one side (daemon, web, phone, extension) go in `shared/`. Keep side effects out of `shared/` so they can be tested directly.
- User-visible strings live in `web/strings.ts` (and `server/strings.ts` for daemon messages) and are in English.
- Styling goes through design tokens. `design-system/tokens.json` is the source; `npm run tokens` generates `web/tokens.css`. `npm run lint:tokens` fails on raw `px` values (other than 1px borders), hex or rgb colors, and Tailwind spacing steps outside the system in `web/`. A real exception needs a `lint-tokens: allow <reason>` comment on that line or the line above.
- Keep code comments for external API contracts, tool directives, and license notices.
- No formatter is enforced; match the style of the file you edit.
- No emojis in code, comments, UI copy or commit messages.

## Tests

Tests are plain scripts run with `tsx`, one file per area in `test/`. Each prints `ok` or `FAIL` per check and exits with a non-zero code when anything fails. There is no test framework.

- Add a new file as `test/<area>.test.ts` and append `&& tsx test/<area>.test.ts` to the `test` script in `package.json`, or add cases to an existing file.
- Test pure logic directly. For daemon behavior, use `useTestDaemon()` from `test/testDaemon.ts`, which starts a private daemon on a temporary data folder and a free port and stops it afterwards.
- Do not call real services. Use the existing fakes: `test/fixtures/fake-claude.mjs` (via `AGENT_NAV_CLAUDE`), `test/fixtures/pr/bin/gh` (put first on `PATH`), `test/fixtures/codex/app-server.mjs`, `test/fixtures/fake-notion-mcp.mjs`, and the fake keychain and `xcrun` runners in the tests that need them.
- Assert on returned values, files and state with literal expected values. Do not add UI snapshot tests.

## Rules that must not change

- **Loopback only.** The main daemon listens on `127.0.0.1` and checks `Host`, `Origin` and the token on every WebSocket. Do not add listeners on other interfaces, wildcard origins or token-less routes. There are two deliberate exceptions, both off by default and separate from the main server: the phone server, which accepts paired phones only, and the Desktop link server (`server/desktopLink.ts`), which accepts paired Macs only, carries every byte inside a Noise IK channel keyed to each Mac's own static key, and refuses the methods in `REMOTE_DENIED_METHODS` (`shared/desktopLink.ts`). The Desktop link server reaches the main daemon through `127.0.0.1` and never sends the main token to the other Mac.
- **The CLI's own account only.** Model calls go through the user's own, unmodified Claude Code CLI (and, for Codex sessions, the Codex CLI) and whatever account that CLI is signed in to. Never read, store or ask for provider credentials. Provider environment variables reach the CLI only when the user turns on `useProviderEnv`; never add another billing path or a silent fallback to one. The only exception is a custom provider the user adds themselves in Settings > Model Providers: its key lives only in the macOS Keychain and is passed only to that provider's own sessions.
- **Explicit writes to remote services.** Anything that writes to GitHub, Slack or Notion happens only after a user action and is checked on the daemon side.
- **Never run provider login or logout** from code or tests, and never read, copy or edit the CLIs' auth files.

## Packaging note

`package.json` keeps `"private": true`. That only stops an accidental `npm publish`; the project is open source under the MIT license.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
