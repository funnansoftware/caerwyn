# caerwyn
Live Stream Multi-Chat VSCode Extension

## Development

Prerequisites: Node.js 20+ and VS Code 1.100+.

```sh
npm install
```

- **Run:** open this folder in VS Code and press `F5`. That starts the watch build and opens an Extension Development Host window. In that window, run **Caerwyn: Hello World** from the Command Palette.
- **Build:** `npm run compile` type-checks, lints and bundles to `dist/`.
- **Test:** `npm test` compiles the tests to `out/` and runs them in a downloaded VS Code instance.
- **Package:** `npx @vscode/vsce package` produces a `.vsix`.
