# caerwyn

Live Stream Multi-Chat VSCode Extension

Caerwyn shows your Twitch and YouTube live chat together in one VS Code editor tab. Because it is an ordinary tab, you can split it, drag it into any editor group and keep it in your layouts.

This version is read-only. It shows messages, emotes, replies, subscriptions, Super Chats and other notices, and it removes messages that moderators delete.

## Setup

Caerwyn signs in to each platform with OAuth. Each platform requires you to register your own application once; Caerwyn then asks for that application's credentials the first time you sign in. Credentials and tokens are kept in VS Code's secret storage, never in settings.

### Twitch

1. Open the [Twitch developer console](https://dev.twitch.tv/console). Twitch requires two-factor authentication on your account.
2. Register an application. Use `http://localhost` as the OAuth redirect URL.
3. If Twitch offers a client type, choose **Public**. Caerwyn does not use a client secret, and Twitch only lets public clients renew a sign-in without one.
4. Copy the application's **Client ID**.
5. In VS Code, run **Caerwyn: Sign In to Twitch**, paste the Client ID and approve access in the browser.

### YouTube

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3** for it.
2. Configure the OAuth consent screen, and add your Google account as a test user if the app is in testing.
3. Create an OAuth client with the application type **TVs and Limited Input devices**. Copy its **Client ID** and **client secret**.
4. In VS Code, run **Caerwyn: Sign In to YouTube** and paste both values. A one-time code is copied to your clipboard; paste it on the Google page that opens and approve access.

Two things to know about Google's side:

- While the consent screen's publishing status is **Testing**, Google expires the sign-in after 7 days and you will need to sign in again.
- YouTube API usage counts against your project's daily quota, 10,000 units by default. Each chat connection costs 5 units. While you have no live or upcoming broadcast, Caerwyn checks for one every minute at 2 units per check.

## Using it

After signing in, the chat tab opens and shows your own channel (Twitch) or your live or upcoming broadcast (YouTube). Run **Caerwyn: Open Chat** to bring it back at any time.

| Command | What it does |
| --- | --- |
| Caerwyn: Open Chat | Opens or reveals the chat tab. |
| Caerwyn: Sign In to Twitch / YouTube | Signs in and adds your own chat. |
| Caerwyn: Sign Out of Twitch / YouTube | Signs out, optionally forgetting the app credentials. |
| Caerwyn: Add Twitch Channel… | Adds another channel's chat by name. |
| Caerwyn: Add YouTube Stream… | Adds another live stream's chat by URL or video ID. |
| Caerwyn: Remove Chat Source… | Removes a chat from the tab. |
| Caerwyn: Reconnect | Reconnects every chat. |
| Caerwyn: Clear Chat | Empties the tab. |

Chat is only read while the chat tab is open. Closing the tab disconnects.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `caerwyn.maxMessages` | `500` | How many recent messages to keep and show. |
| `caerwyn.showTimestamps` | `false` | Shows the time next to each message. |
| `caerwyn.youtube.transport` | `stream` | `stream` keeps one connection open. `poll` asks for new messages every few seconds and uses quota on every request; use it only if streaming does not work. |

Problems are logged to the **Caerwyn** output channel.

## Development

Prerequisites: Node.js 20+ and VS Code 1.100+.

```sh
npm install
```

- **Run:** open this folder in VS Code and press `F5`. That starts the watch build and opens an Extension Development Host window. In that window, run **Caerwyn: Open Chat** from the Command Palette.
- **Build:** `npm run compile` type-checks, lints and bundles to `dist/`.
- **Test:** `npm test` compiles the tests to `out/` and runs them in a downloaded VS Code instance. The tests use a local stand-in for each platform and need no accounts.
- **Package:** `npx @vscode/vsce package` produces a `.vsix`.

### How it fits together

- `src/auth/` signs in with the OAuth device flow and keeps tokens fresh. Each platform implements `OAuthClient`.
- `src/chat/twitch/` reads Twitch chat through EventSub over WebSocket.
- `src/chat/youtube/` reads YouTube chat through the Data API's streaming method.
- `src/chat/chatService.ts` owns the list of chat sources, their connections and the recent message history. Both platforms are mapped to the types in `src/chat/types.ts`.
- `src/panel/` hosts the chat tab, and `src/webview/` is the script and stylesheet that render it. The webview is type-checked separately because it runs in a browser context.
