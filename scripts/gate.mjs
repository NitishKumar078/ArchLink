// Re-runs the Phase 0 gate across every cloned target and prints one table.
// Targets are gitignored; clone them with scripts/clone-targets.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const TARGETS = [
  ['targets/fixture-next', 'fixture (planted faults)'],
  ['targets/commerce', 'vercel/commerce'],
  ['targets/dub/apps/web', 'dub apps/web'],
  ['targets/cal.com/apps/web', 'cal.com apps/web'],
  ['targets/ui/apps/v4', 'shadcn-ui apps/v4'],
  ['targets/cal.com', 'cal.com ROOT (monorepo)'],
];

const pad = (s, n, left = false) =>
  left ? String(s).padStart(n) : String(s).padEnd(n);

console.log(
  [pad('TARGET', 26), pad('FILES', 7, 1), pad('EDGES', 8, 1), pad('UNRES', 6, 1),
   pad('RATE%', 7, 1), pad('VERDICT', 12, 1), pad('BARRELS', 8, 1), pad('UNTRACED', 9, 1)].join(' '),
);
console.log('-'.repeat(92));

let worst = 0;
for (const [dir, name] of TARGETS) {
  if (!fs.existsSync(dir)) { console.log(`${pad(name, 26)}  (not cloned)`); continue; }
  const out = execFileSync('node', ['src/probe.ts', dir, '--json'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  if (!dir.includes('fixture')) worst = Math.max(worst, j.unresolvedRate);
  console.log(
    [pad(name, 26), pad(j.files, 7, 1), pad(j.edges, 8, 1), pad(j.unresolvedEdges, 6, 1),
     pad(j.unresolvedRate.toFixed(2), 7, 1), pad(j.verdict, 12, 1),
     pad(j.barrelResolved, 8, 1), pad(j.barrelFallbacks, 9, 1)].join(' '),
  );
}
console.log(`\nworst real-project rate: ${worst.toFixed(2)}%  (gate: <2% green, >10% stop)`);
process.exit(worst > 10 ? 1 : 0);
