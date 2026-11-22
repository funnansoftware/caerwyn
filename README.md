# caerwyn

Live Stream Multi-Chat VSCode Extension

Caerwyn shows your Twitch and YouTube live chat together in one VS Code editor tab. Because it is an ordinary tab, you can split it, drag it into any editor group and keep it in your layouts.

This version is for reading chat. It shows messages, emotes, replies, subscriptions, Super Chats and other notices, and it removes messages that moderators delete. The one thing it can do on Twitch is allow or deny the messages AutoMod holds in your own channel.

## Setup

Caerwyn signs in to each platform with OAuth. Each platform requires you to register your own application once; Caerwyn then asks for that application's credentials the first time you sign in. Credentials and tokens are kept in VS Code's secret storage, never in settings.

### Twitch

1. Open the [Twitch developer console](https://dev.twitch.tv/console). Twitch requires two-factor authentication on your account.
2. Register an application. Use `http://localhost` as the OAuth redirect URL.
3. If Twitch offers a client type, choose **Public**. Caerwyn does not use a client secret, and Twitch only lets public clients renew a sign-in without one.
4. Copy the application's **Client ID**.
5. In VS Code, run **Caerwyn: Sign In to Twitch**, paste the Client ID and approve access in the browser.

Caerwyn asks to read your chat, your channel points redemptions and the Bits spent in your channel, and to manage AutoMod's held messages. The redemptions and Bits show what viewers paid for highlighted messages, Power-ups and other rewards in your own channel; Twitch shares them with nobody else. Managing held messages shows you what AutoMod is holding in your channel, with **Allow** and **Deny** buttons. It is the only thing Caerwyn changes on Twitch, and only when you click one of them. A held message's text stays hidden until you click **Show message**, so it does not appear on stream by accident.

If you signed in before Caerwyn asked for all of these, your chat still works, but run **Caerwyn: Sign In to Twitch** again to get the rest.

### YouTube

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3** for it.
2. Configure the OAuth consent screen, and add your Google account as a test user if the app is in testing.
3. Create an OAuth client with the application type **TVs and Limited Input devices**. Copy its **Client ID** and **client secret**.
4. In VS Code, run **Caerwyn: Sign In to YouTube** and paste both values. A one-time code is copied to your clipboard; paste it on the Google page that opens and approve access.

Two things to know about Google's side:

- While the consent screen's publishing status is **Testing**, Google expires the sign-in after 7 days and you will need to sign in again.
- YouTube API usage counts against your project's daily quota, 10,000 units by default. Each chat connection costs 5 units. While you have no live or upcoming broadcast, Caerwyn checks for one every minute at 2 units per check. While a chat is open, Caerwyn checks the broadcast every minute for its viewer count and title, at 1 unit. Until that broadcast is live, the check also looks for a different broadcast that has gone live, at 1 more unit, and switches to its chat.

## Using it

After signing in, the chat tab opens and shows your own channel (Twitch) or your live or upcoming broadcast (YouTube). Run **Caerwyn: Open Chat** to bring it back at any time.

| Command | What it does |
| --- | --- |
| Caerwyn: Open Chat | Opens or reveals the chat tab. |
| Caerwyn: Open Chat in Sidebar | Opens the Caerwyn view in the sidebar. |
| Caerwyn: Sign In to Twitch / YouTube | Signs in and adds your own chat. |
| Caerwyn: Sign Out of Twitch / YouTube | Signs out, optionally forgetting the app credentials. |
| Caerwyn: Add Twitch Channel… | Adds another channel's chat by name. |
| Caerwyn: Add YouTube Stream… | Adds another live stream's chat by URL or video ID. |
| Caerwyn: Remove Chat Source… | Removes a chat from the tab. |
| Caerwyn: Reconnect | Reconnects every chat. |
| Caerwyn: Clear Chat | Empties the tab. |

The chat also lives in the **Caerwyn** view in the activity bar. The tab and the sidebar view show the same chat, and you can use either or both. Drag the view to the secondary sidebar or the bottom panel if you prefer it there.

Chat is only read while the chat tab or the sidebar view is open. Closing the last one disconnects.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `caerwyn.maxMessages` | `500` | How many recent messages to keep and show. |
| `caerwyn.showTimestamps` | `false` | Shows the time next to each message. |
| `caerwyn.youtube.transport` | `stream` | `stream` keeps one connection open. `poll` asks for new messages every few seconds and uses quota on every request; use it only if streaming does not work. |

Problems are logged to the **Caerwyn** output channel.

## Simulated chat

Simulated chat fills the tab with made-up Twitch and YouTube chat, so you can try Caerwyn or work on its features without signing in. The tab is titled **Caerwyn Chat (Simulated)** while it is on.

- **Caerwyn: Toggle Simulated Chat** switches it on or off. It stays on across restarts until you switch it off, and switching it off removes the simulated messages.
- **Caerwyn: Simulate Chat Event…** sends one event of your choice: a subscription, raid, Super Chat, deleted message, timeout, cleared chat, a burst of 50 messages, a dropped connection and so on. **Showcase** sends one of every kind. The same command is on the chat tab's title bar while simulation is on.

| Setting | Default | What it does |
| --- | --- | --- |
| `caerwyn.simulation.enabled` | `false` | Shows simulated chat. |
| `caerwyn.simulation.messagesPerSecond` | `2` | How fast simulated chat arrives. `0` stops the automatic flow, leaving only the events you send, so the view holds still while you work on it. |

The simulator builds payloads shaped like the platforms' documented ones and runs them through the same mapping code as real chat. It is not a recording of real traffic, so it shows how Caerwyn displays an event, not that a platform sends exactly that.

## Development

Prerequisites: Node.js 20+ and VS Code 1.100+.

```sh
npm install
```

- **Run:** open this folder in VS Code and press `F5`. That starts the watch build and opens an Extension Development Host window. In that window, run **Caerwyn: Open Chat** from the Command Palette.
- **Iterate on the chat view:** switch on [simulated chat](#simulated-chat). After changing `src/webview/`, run **Developer: Reload Webviews** in the Extension Development Host to load the rebuilt script and stylesheet. The recent messages are shown again, but without removed ones, since those are dropped from history; run **Caerwyn: Clear Chat** and then the **Showcase** event to see "message deleted" rows again. Changes elsewhere in `src/` need the host restarted (the restart button on the debug toolbar).
- **Build:** `npm run compile` type-checks, lints and bundles to `dist/`.
- **Test:** `npm test` compiles the tests to `out/` and runs them in a downloaded VS Code instance. The tests use a local stand-in for each platform and need no accounts.
- **Package:** `npx @vscode/vsce package` produces a `.vsix`.

### How it fits together

- `src/auth/` signs in with the OAuth device flow and keeps tokens fresh. Each platform implements `OAuthClient`.
- `src/chat/twitch/` reads Twitch chat through EventSub over WebSocket.
- `src/chat/youtube/` reads YouTube chat through the Data API's streaming method.
- `src/chat/simulation/` produces simulated chat. `sampleData.ts` holds the made-up chatters and lines; `simulatedChat.ts` lists every event it can produce.
- `src/chat/chatService.ts` owns the list of chat sources, their connections and the recent message history. Both platforms are mapped to the types in `src/chat/types.ts`.
- `src/panel/` hosts the chat tab, and `src/webview/` is the script and stylesheet that render it. The webview is type-checked separately because it runs in a browser context.
