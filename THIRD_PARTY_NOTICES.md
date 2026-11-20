# Third-party notices

Lodestar's own code is under the MIT License (see [LICENSE](LICENSE)). It depends on and bundles the components below. Versions and license identifiers were read from each package's `package.json` in `node_modules` (root) and `mobile/node_modules` (phone client) for the versions pinned in the lockfiles. Full license texts ship inside each package.

## Root runtime dependencies (`package.json` `dependencies`)

| Package | Version | License |
| --- | --- | --- |
| @anthropic-ai/claude-agent-sdk | 0.3.296 | Proprietary. `package.json` says "SEE LICENSE IN README.md"; its `LICENSE.md` reads "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." Not redistributed in this repository; installed from npm. |
| @codemirror/merge | 6.12.2 | MIT |
| @fontsource-variable/geist | 5.3.0 | OFL-1.1 |
| @fontsource-variable/geist-mono | 5.3.0 | OFL-1.1 |
| @lydell/node-pty | 1.2.0-beta.15 | MIT |
| @radix-ui/react-checkbox | 1.3.12 | MIT |
| @radix-ui/react-dialog | 1.2.0 | MIT |
| @radix-ui/react-dropdown-menu | 2.1.25 | MIT |
| @radix-ui/react-select | 2.3.8 | MIT |
| @radix-ui/react-slot | 1.4.0 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| @vscode/codicons | 0.0.46-44 | CC-BY-4.0 (icons and font); code under MIT (`LICENSE-CODE`), Copyright Microsoft Corporation |
| @xterm/addon-fit | 0.11.0 | MIT |
| @xterm/addon-ligatures | 0.10.0 | MIT |
| @xterm/xterm | 6.0.0 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| cm6-graphql | 0.2.2 | MIT |
| graphql | 16.14.2 | MIT |
| tailwind-merge | 3.7.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| typescript-language-server | 6.0.2 | Apache-2.0 |
| ws | 8.22.0 | MIT |
| zod | 4.6.5 | MIT |

## Bundled into the web UI from `devDependencies`

Vite bundles these into `dist/`, so they ship with the app even though they are listed as development dependencies.

| Package | Version | License |
| --- | --- | --- |
| react, react-dom | 19.3.0 | MIT |
| codemirror | 6.0.2 | MIT |
| @codemirror/* (autocomplete, language, legacy-modes, lsp-client, state, view, lang-*) | see `package.json` | MIT |
| @lezer/common, @lezer/highlight | 1.5.3, 1.2.5 | MIT |
| dompurify | 3.3.0 | MPL-2.0 OR Apache-2.0 |
| marked | 18.1.0 | MIT |
| qrcode-generator | 2.0.4 | MIT |

The packaged app also contains Electron 44.7.0 (MIT), which itself includes Chromium and Node.js under their own licenses (shipped inside the Electron distribution).

Every installed `@codemirror/*` package (autocomplete, commands, lang-css, lang-go, lang-html, lang-java, lang-javascript, lang-json, lang-markdown, lang-python, lang-sql, lang-xml, lang-yaml, language, legacy-modes, lint, lsp-client, merge, search, state, streamparser, view) declares MIT.

## Phone client runtime dependencies (`mobile/package.json` `dependencies`)

| Package | Version | License |
| --- | --- | --- |
| @react-native-async-storage/async-storage | 2.2.0 | MIT |
| @shopify/flash-list | 2.3.2 | MIT |
| expo | 58.0.14 | MIT |
| expo-camera | 58.0.10 | MIT |
| expo-clipboard | 58.0.3 | MIT |
| expo-constants | 58.0.12 | MIT |
| expo-font | 58.0.8 | MIT |
| expo-haptics | 58.0.7 | MIT |
| expo-image | 58.0.15 | MIT |
| expo-image-manipulator | 58.0.14 | MIT |
| expo-image-picker | 58.0.10 | MIT |
| expo-linking | 58.0.13 | MIT |
| expo-router | 58.0.23 | MIT |
| expo-secure-store | 58.0.2 | MIT |
| expo-status-bar | 58.0.3 | MIT |
| expo-symbols | 58.0.4 | MIT |
| expo-system-ui | 58.0.6 | MIT |
| marked | 18.1.0 | MIT |
| react | 19.3.0 | MIT |
| react-native | 0.88.0 | MIT |
| react-native-safe-area-context | 5.10.1 | MIT |
| react-native-screens | 4.30.0 | MIT |

## Fonts and icon sets in this repository

| Asset | Where | License |
| --- | --- | --- |
| Codicons font (`codicon.ttf`) | bundled from `@vscode/codicons` via `web/fonts.css` | CC-BY-4.0, Copyright Microsoft Corporation |
| Geist and Geist Mono | `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`, declared in `web/fonts.css` (currently not used by the UI) | SIL Open Font License 1.1, Copyright The Geist Project Authors |
| Material Icon Theme file icons | `public/material-icons/*.svg`, `web/material-icons/theme.json` (theme version 5.39.0) | MIT, Copyright (c) 2025 Material Extensions; full text in `public/material-icons/LICENSE.txt` |

## Visual Studio Code (Code - OSS)

Lodestar's editor, tab strip, find widget, peek view, search view, status bar, quick input and browser tab follow the layout of Visual Studio Code. Sizes, the Dark Modern and Light Modern color values, setting names (`editor.*`, `files.*`, `workbench.browser.*`), command names and a number of menu and message strings are the same as in the open-source `microsoft/vscode` repository, which is published under the MIT License. Some logic is reimplemented in TypeScript following the corresponding code in that repository, for example the Go to File fuzzy scorer, indentation detection, Go to Line and Go to Symbol input parsing, word highlighting and the rename preview. This notice covers those ports and the matching values and strings.

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Trademarks

Visual Studio Code and VS Code are trademarks of Microsoft Corporation. Claude and Claude Code are trademarks of Anthropic, PBC. Codex is a trademark of OpenAI. WebStorm is a trademark of JetBrains s.r.o. The file icons include logos of other products, which belong to their owners. These names and logos are used only to refer to those products. Lodestar is not affiliated with, sponsored by or endorsed by any of these companies.
