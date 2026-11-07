/**
 * Phase 0 gate.
 *
 * Runs the analyzer against a real project and prints the one number that
 * decides whether this extension is worth building: the unresolved-edge rate.
 *
 *   < 2%   green  - build it
 *   2-10%  investigate the causes
 *   > 10%  stop   - the idea does not survive contact with real code
 *
 * Usage: node src/probe.ts <project-root> [--json] [--top N]
 */
import * as path from 'node:path';
import { analyze } from './analyzer/index.ts';
import type { Category, EdgeKind } from './analyzer/types.ts';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const topIdx = argv.indexOf('--top');
const TOP = topIdx >= 0 ? Number(argv[topIdx + 1]) : 15;
const root = argv.find((a) => !a.startsWith('--') && a !== String(TOP));

if (!root) {
  console.error('usage: node src/probe.ts <project-root> [--json] [--top N]');
  process.exit(2);
}

const graph = analyze(path.resolve(root));
const d = graph.diagnostics;

const internalEdges = graph.edges.filter((e) => e.to !== null).length;
// Undecidable specifiers are excluded from the rate: the gate measures whether
// our resolver failed at something it should have handled, not whether static
// analysis has limits. They are reported on their own line instead.
const unanalyzable = graph.edges.filter((e) => e.unanalyzable).length;
const unresolvedEdges = graph.edges.filter((e) => e.to === null && !e.unanalyzable).length;
const totalEdges = internalEdges + unresolvedEdges;
const rate = totalEdges === 0 ? 0 : (unresolvedEdges / totalEdges) * 100;

const verdict = rate < 2 ? 'GREEN' : rate <= 10 ? 'INVESTIGATE' : 'STOP';

if (asJson) {
  console.log(JSON.stringify({
    root: graph.root,
    files: d.filesScanned,
    edges: totalEdges,
    unresolvedEdges,
    unresolvedRate: Number(rate.toFixed(2)),
    undecidable: unanalyzable,
    verdict,
    barrelResolved: d.barrelResolved,
    barrelFallbacks: d.barrelFallbacks,
    timings: d.timings,
  }, null, 2));
  process.exit(0);
}

const bar = (n: number, max: number, width = 28): string =>
  '#'.repeat(Math.max(0, Math.round((n / Math.max(1, max)) * width)));

const categories = new Map<Category, number>();
for (const n of graph.nodes.values()) {
  categories.set(n.category, (categories.get(n.category) ?? 0) + 1);
}
const kinds = new Map<EdgeKind, number>();
for (const e of graph.edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);

const renders = graph.edges.filter((e) => e.badges?.renders).length;
const viaBarrel = graph.edges.filter((e) => e.badges?.viaBarrel).length;
const clientFiles = [...graph.nodes.values()].filter((n) => n.directive === 'use client').length;
const serverFiles = [...graph.nodes.values()].filter((n) => n.directive === 'use server').length;

const routes = [...graph.nodes.values()]
  .filter((n) => n.category === 'route' && n.routePath)
  .sort((a, b) => a.routePath!.localeCompare(b.routePath!));

const mostDepended = [...graph.dependents.entries()]
  .map(([id, set]) => [id, set.size] as const)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);

const line = '='.repeat(66);
console.log(`\n${line}\n PHASE 0 PROBE  ${graph.root}\n${line}`);

console.log(`\nPROJECT`);
console.log(`  tsconfig        ${d.tsconfigPath ? path.relative(graph.root, d.tsconfigPath) : 'none (using defaults)'}`);
console.log(`  files scanned   ${d.filesScanned}${d.filesSkipped ? `  (${d.filesSkipped} unreadable)` : ''}`);
console.log(`  syntax errors   ${d.syntaxErrors.length}`);
if (d.isMonorepo) console.log(`  monorepo        YES - ${d.monorepoReason}  (out of MVP scope)`);

console.log(`\nGATE`);
console.log(`  total edges     ${totalEdges}`);
console.log(`  resolved        ${internalEdges}`);
console.log(`  unresolved      ${unresolvedEdges}`);
console.log(`  undecidable     ${unanalyzable}   (non-literal specifier; excluded from the rate)`);
console.log(`  asset imports   ${d.assetImports}   (css/img/json; not modules, excluded)`);
console.log(`  UNRESOLVED RATE ${rate.toFixed(2)}%   ->  ${verdict}`);

console.log(`\nBARRELS`);
console.log(`  chains followed ${d.barrelResolved}   (imports traced past an index file to the real definition)`);
console.log(`  via package     ${d.barrelExternal}   (re-exported from an external package; chain correctly ends local)`);
console.log(`  untraced        ${d.barrelFallbacks}   (name not found anywhere; edge kept, pointed at the barrel)`);
console.log(`  edges badged    ${viaBarrel}`);

console.log(`\nEDGE KINDS`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(n).padStart(6)}  ${bar(n, totalEdges)}`);
}
console.log(`  ${'renders badge'.padEnd(16)} ${String(renders).padStart(6)}  (import also used as a JSX element)`);

console.log(`\nNODE CATEGORIES`);
const maxCat = Math.max(...categories.values(), 1);
for (const [c, n] of [...categories].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(16)} ${String(n).padStart(6)}  ${bar(n, maxCat)}`);
}
if (clientFiles || serverFiles) {
  console.log(`  'use client'     ${String(clientFiles).padStart(6)}`);
  console.log(`  'use server'     ${String(serverFiles).padStart(6)}`);
}

if (routes.length) {
  console.log(`\nROUTES DETECTED (${routes.length}, showing ${Math.min(TOP, routes.length)})`);
  for (const r of routes.slice(0, TOP)) {
    console.log(`  ${(r.routePath ?? '').padEnd(42)} ${r.id}`);
  }
}

if (mostDepended.length) {
  console.log(`\nMOST DEPENDED-UPON FILES`);
  for (const [id, n] of mostDepended) {
    console.log(`  ${String(n).padStart(4)} dependents  ${id}`);
  }
}

if (d.unresolved.size) {
  const top = [...d.unresolved].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  console.log(`\nTOP UNRESOLVED SPECIFIERS (${d.unresolved.size} distinct)`);
  for (const [spec, n] of top) console.log(`  ${String(n).padStart(4)}x  ${spec}`);
}

console.log(`\nTIMINGS (ms)`);
for (const [k, v] of Object.entries(d.timings)) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}`);
}
const perFile = d.filesScanned ? d.timings.total / d.filesScanned : 0;
console.log(`  per file         ${perFile.toFixed(2)}`);
console.log(`  rss MB           ${(process.memoryUsage().rss / 1048576).toFixed(0)}`);
console.log(`\n${line}\n`);
