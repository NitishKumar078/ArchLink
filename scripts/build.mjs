/**
 * Two bundles, two very different targets:
 *
 *  - out/extension.cjs : extension host. CommonJS, node platform, `vscode`
 *    external. Named .cjs because package.json declares "type": "module" so
 *    the analyzer source can run under `node --test` with no build step.
 *  - out/webview.js    : the panel. Browser IIFE, no node builtins, bundles
 *    React + React Flow. CSS is emitted alongside as out/webview.css.
 */
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const shared = {
  bundle: true,
  sourcemap: true,
  minify,
  logLevel: 'info',
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
};

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.cjs',
  format: 'cjs',
  platform: 'node',
  // Must not exceed the Electron/Node version of the oldest supported host.
  target: 'node18',
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webviewBuild = {
  ...shared,
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'out/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') },
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionBuild),
    esbuild.context(webviewBuild),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching extension + webview...');
} else {
  await Promise.all([esbuild.build(extensionBuild), esbuild.build(webviewBuild)]);
}
