const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Reports build start/end in the format the `esbuild-problem-matchers` extension expects.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log('[watch] build finished');
		});
	},
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

/** The extension host bundle (Node). @type {import('esbuild').BuildOptions} */
const extension = {
	...shared,
	entryPoints: ['src/extension.ts'],
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	outfile: 'dist/extension.js',
	// `bufferutil` and `utf-8-validate` are optional native speed-ups for `ws`; it works without them.
	external: ['vscode', 'bufferutil', 'utf-8-validate'],
};

/** The chat tab's script and stylesheet (browser). @type {import('esbuild').BuildOptions} */
const webview = {
	...shared,
	entryPoints: [
		{ in: 'src/webview/main.ts', out: 'webview' },
		{ in: 'src/webview/chat.css', out: 'webview' },
	],
	format: 'iife',
	platform: 'browser',
	target: 'es2022',
	outdir: 'dist',
};

async function main() {
	const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
	if (watch) {
		await Promise.all(contexts.map((ctx) => ctx.watch()));
	} else {
		await Promise.all(contexts.map((ctx) => ctx.rebuild()));
		await Promise.all(contexts.map((ctx) => ctx.dispose()));
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
