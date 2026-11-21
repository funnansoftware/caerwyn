import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		// Some suites wait on real timers (reconnect delays, a local WebSocket server).
		timeout: 20000,
	},
});
