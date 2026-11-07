/**
 * Renders the real webview bundle outside the extension host, against a real
 * analyzed project, so the UI can be inspected (and screenshotted) without
 * clicking through a command palette.
 *
 *   node scripts/preview.mjs <project-root> [anchor-id] [--dir out|in|both]
 *
 * Expansion is fully interactive here: the harness bundles the *same*
 * `explore`/`branchFrom` from src/analyzer/query.ts and runs it in the browser
 * in place of the extension host, so clicking "+3" does exactly what it does
 * in the panel. No logic is duplicated.
 *
 * Dev-only. Never shipped, never referenced by the extension.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { analyze } from '../src/analyzer/index.ts';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1]?.startsWith('--')));

const root = positional[0];
if (!root) {
  console.error('usage: node scripts/preview.mjs <project-root> [anchor] [--dir out|in|both]');
  process.exit(2);
}
const direction = flag('dir', 'out');

console.log(`analyzing ${root} ...`);
const started = Date.now();
const graph = analyze(path.resolve(root));
const analysisMs = Date.now() - started;

// Anchor: explicit, else the route with the most dependencies.
let anchor = positional[1];
if (!anchor || !graph.nodes.has(anchor)) {
  const outDeg = new Map();
  for (const e of graph.edges) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
  const routes = [...graph.nodes.values()].filter((n) => n.category === 'route');
  const pool = routes.length ? routes : [...graph.nodes.values()];
  anchor = pool.sort((a, b) => (outDeg.get(b.id) ?? 0) - (outDeg.get(a.id) ?? 0))[0]?.id;
}

const d = graph.diagnostics;
const stats = {
  filesScanned: d.filesScanned,
  resolvedEdges: graph.edges.filter((e) => e.to !== null).length,
  unresolvedEdges: graph.edges.filter((e) => e.to === null && !e.unanalyzable).length,
  undecidable: d.unanalyzableImports,
  barrelChains: d.barrelResolved,
  isMonorepo: d.isMonorepo,
  monorepoReason: d.monorepoReason,
  analysisMs,
};

fs.mkdirSync('out', { recursive: true });

// The whole project graph, so the browser-side engine can explore it freely.
fs.writeFileSync(path.join('out', 'graph.json'), JSON.stringify({
  root: graph.root,
  nodes: [...graph.nodes.values()],
  edges: graph.edges,
  anchor,
  direction,
  stats,
  availableCategories: [...new Set([...graph.nodes.values()].map((n) => n.category))].sort(),
}));

// The real query module, bundled for the browser. It imports only types, so
// this is the same code the extension runs.
await esbuild.build({
  stdin: {
    contents: `export { explore, branchFrom } from '${
      path.resolve('src/analyzer/query.ts').replace(/\\/g, '/')
    }';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: 'out/preview-engine.js',
  bundle: true,
  format: 'iife',
  globalName: 'RREQuery',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'silent',
});

const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Preview - ${anchor}</title>
<link rel="stylesheet" href="webview.css">
<style>
  /* Stand in for the editor theme tokens the real panel inherits. */
  :root {
    --vscode-editor-background:#1f2126; --vscode-editor-foreground:#d6dae0;
    --vscode-descriptionForeground:#9aa4b2; --vscode-panel-border:rgba(140,150,165,.35);
    --vscode-input-background:#2a2d34; --vscode-button-background:#2f6fd0;
    --vscode-button-foreground:#fff; --vscode-button-secondaryBackground:rgba(140,150,165,.18);
    --vscode-focusBorder:#4c9ae8; --vscode-editorWarning-foreground:#d9a63a;
    --vscode-font-family:system-ui,-apple-system,Segoe UI,sans-serif;
    --vscode-editor-font-family:ui-monospace,Consolas,monospace;
  }
</style>
</head><body>
<div id="root"></div>
<script src="preview-engine.js"></script>
<script>
(async () => {
  const raw = await (await fetch('graph.json')).json();
  // Rebuild the Map shape explore() expects.
  const graph = {
    root: raw.root,
    nodes: new Map(raw.nodes.map((n) => [n.id, n])),
    edges: raw.edges,
    dependents: new Map(),
    diagnostics: {},
  };

  const state = { anchor: raw.anchor, expanded: [], direction: raw.direction, hidden: [] };

  const visibleCategories = () => {
    if (state.hidden.length === 0) return undefined;
    const hidden = new Set(state.hidden);
    return new Set(raw.availableCategories.filter((c) => !hidden.has(c)));
  };

  function send() {
    const explored = RREQuery.explore(graph, {
      anchor: state.anchor,
      expanded: new Set(state.expanded),
      direction: state.direction,
      categories: visibleCategories(),
      maxNodes: 400,
    });
    window.postMessage({
      type: 'graph',
      graph: explored,
      state: { ...state },
      stats: raw.stats,
      positions: {},
      availableCategories: raw.availableCategories,
    }, '*');
  }

  // Stands in for the extension host, running the identical message handling.
  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      console.log('[webview->ext]', m.type, m.id ?? '');
      switch (m.type) {
        case 'ready': send(); break;
        case 'expand': state.expanded = [...new Set([...state.expanded, m.id])]; send(); break;
        case 'collapse': state.expanded = state.expanded.filter((i) => i !== m.id); send(); break;
        case 'expandBranch': {
          const branch = RREQuery.branchFrom(graph, m.id, state.direction, visibleCategories(), 400);
          state.expanded = [...new Set([...state.expanded, ...branch])];
          send();
          break;
        }
        case 'collapseAll': state.expanded = []; send(); break;
        case 'setAnchor': state.anchor = m.id; state.expanded = []; send(); break;
        case 'requery': Object.assign(state, m.state); send(); break;
        default: break; // openFile / savePositions are no-ops out of the editor
      }
    },
  });

  // Only now load the app, so acquireVsCodeApi exists when it mounts.
  const s = document.createElement('script');
  s.src = 'webview.js';
  document.body.appendChild(s);
})();
</script>
</body></html>`;

fs.writeFileSync(path.join('out', 'preview.html'), html);

console.log(`anchor      : ${anchor}`);
console.log(`project     : ${d.filesScanned} files, ${graph.edges.length} edges, ${analysisMs}ms`);
console.log(`wrote       : out/preview.html (+ graph.json, preview-engine.js)`);
console.log(`serve with  : node scripts/preview-server.mjs`);
