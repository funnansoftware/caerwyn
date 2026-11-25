# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Caerwyn is a VS Code extension (TypeScript, bundled with esbuild) that shows Twitch and YouTube live chat together in one editor tab or sidebar view. See README.md for user-facing setup, commands and settings.

## Commands

```bash
npm run compile        # check-types + lint + esbuild (dev build)
npm run watch          # esbuild + tsc (extension) + tsc (webview) in parallel; use the VS Code "watch" task / F5
npm run check-types    # tsc --noEmit for BOTH tsconfig.json and src/webview/tsconfig.json
npm run lint           # eslint src
npm test               # vscode-test: runs out/test/**/*.test.js inside a downloaded VS Code instance
npm run package        # production build (minified), runs on vscode:prepublish
```

- `npm test` runs `pretest` first (`tsc -p . --outDir out` + `compile`), so tests execute from compiled `out/`, not from `src/`.
- Tests are Mocha (20s timeout; some wait on real timers or a local WebSocket server) and run in the VS Code extension host. To run a subset, compile first (`npm run pretest`), then `npx vscode-test --grep "<suite or test name>"`.
- Tests live in `src/test/*.test.ts`; shared fixtures in `src/test/helpers.ts`.

## Architecture

Two separately built and type-checked halves that talk only through typed messages:

- **Extension host** (`src/extension.ts` → `dist/extension.js`, Node/CJS, `vscode` external). `tsconfig.json` excludes `src/webview`.
- **Webview** (`src/webview/main.ts` + `chat.css` → `dist/webview.js`/`.css`, browser IIFE). Has its own `src/webview/tsconfig.json` (DOM lib, `types: []`), so it must not import `vscode` or Node code. It may import only *types* from `src/panel/protocol.ts` and `src/chat/types.ts`.

`src/panel/protocol.ts` defines `HostMessage` / webview→host messages; change both sides together when adding a message.

Host data flow:

1. `extension.ts` wires everything: auth, `ChatService`, `ChatHistory`, controls, commands, and the two UI surfaces.
2. `chat/chatService.ts` is the hub. It owns the set of chat sources, aggregates events (messages, deletions, notices, viewer counts, status) from per-platform clients (`chat/twitch/*`, `chat/youtube/*`, `chat/simulation/*`) and exposes them via the small `util/emitter.ts` event emitter. Each platform has a `*Chat` client plus a `*Mapper` that normalises platform payloads into the shared types in `chat/types.ts`.
3. `panel/chatWebview.ts` is the shared bridge to a webview; `chatPanel.ts` (editor tab) and `chatSidebar.ts` (activity-bar view) are two hosts of the same chat. Chat is only connected while at least one is open.
4. `auth/` implements OAuth per platform (Twitch public-client flow; YouTube device-code flow), with credentials and tokens in VS Code secret storage, never in settings. `auth/signIn.ts` orchestrates sign-in/out.
5. `chat/history.ts` persists messages locally for per-viewer user cards (capped per viewer per channel; simulated chat is never saved). `chat/moderation.ts` carries the one write action on Twitch: allowing/denying AutoMod-held messages.
6. `controls/` implements viewer-run chat commands (e.g. `!theme`): `chatControls.ts` handles permissions, cooldowns, the delay window and cancellation on delete/ban; `themeControl.ts` is a command implementation behind a host interface (`vscodeThemeHost.ts`) so it is testable; `chatReplies.ts` posts replies (needs the extra Twitch `user:write:chat` scope, requested only when replies are on). Controls only listen to the user's own signed-in channel/broadcast.

Twitch OAuth scopes are declared in `extension.ts` (`TWITCH_SCOPES`); adding a scope requires users to sign in again.

## Notes

- Contributed commands, views and settings are declared in `package.json` under `contributes`; new ones need an entry there as well as code.
- YouTube API calls consume a daily quota (README documents the per-call costs); avoid adding polling without accounting for it.
- Code style: tabs for indentation, single quotes (match surrounding files; ESLint config is `eslint.config.mjs`).
