import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExport, type ExportTable } from './barrels.ts';

/** Terse table builder so each test reads as the project shape it describes. */
function table(p: {
  local?: string[];
  named?: Record<string, [from: string, imported: string]>;
  stars?: string[];
  externalNames?: string[];
  hasExternalStar?: boolean;
}): ExportTable {
  return {
    local: new Set(p.local ?? []),
    named: new Map(Object.entries(p.named ?? {}).map(([k, v]) => [k, { from: v[0], imported: v[1] }])),
    stars: p.stars ?? [],
    externalNames: new Set(p.externalNames ?? []),
    hasExternalStar: p.hasExternalStar ?? false,
  };
}

test('a name defined locally resolves to that same file', () => {
  const t = new Map([['lib/utils.ts', table({ local: ['cn'] })]]);
  assert.deepEqual(resolveExport('lib/utils.ts', 'cn', t), { target: 'lib/utils.ts' });
});

test('AC3: a named import through a barrel reaches the defining file', () => {
  // components/index.ts: export { Button } from './Button'
  const t = new Map([
    ['components/index.ts', table({ named: { Button: ['components/Button.tsx', 'Button'] } })],
    ['components/Button.tsx', table({ local: ['Button'] })],
  ]);
  assert.deepEqual(resolveExport('components/index.ts', 'Button', t), {
    target: 'components/Button.tsx',
    viaBarrel: 'components/index.ts',
  });
});

test('a default export re-exported under a new name is traced', () => {
  // index.ts: export { default as Card } from './Card'
  const t = new Map([
    ['index.ts', table({ named: { Card: ['Card.tsx', 'default'] } })],
    ['Card.tsx', table({ local: ['default'] })],
  ]);
  assert.deepEqual(resolveExport('index.ts', 'Card', t), {
    target: 'Card.tsx',
    viaBarrel: 'index.ts',
  });
});

test('a star re-export is followed', () => {
  const t = new Map([
    ['index.ts', table({ stars: ['shared.ts'] })],
    ['shared.ts', table({ local: ['helper'] })],
  ]);
  assert.deepEqual(resolveExport('index.ts', 'helper', t), {
    target: 'shared.ts',
    viaBarrel: 'index.ts',
  });
});

test('a multi-hop barrel chain is followed to the end', () => {
  const t = new Map([
    ['a/index.ts', table({ stars: ['b/index.ts'] })],
    ['b/index.ts', table({ named: { deep: ['c/impl.ts', 'deep'] } })],
    ['c/impl.ts', table({ local: ['deep'] })],
  ]);
  const hit = resolveExport('a/index.ts', 'deep', t);
  assert.equal(hit?.target, 'c/impl.ts');
  // The barrel recorded is the first one entered, which is what the user clicked.
  assert.equal(hit?.viaBarrel, 'a/index.ts');
});

test('export * does not forward a default export (ES semantics)', () => {
  const t = new Map([
    ['index.ts', table({ stars: ['impl.ts'] })],
    ['impl.ts', table({ local: ['default'] })],
  ]);
  assert.equal(resolveExport('index.ts', 'default', t), null);
});

test('a name re-exported from an npm package is flagged external, not untraced', () => {
  // icons.ts: export { ChevronDownIcon } from 'lucide-react'
  const t = new Map([['icons.ts', table({ externalNames: ['ChevronDownIcon'] })]]);
  assert.deepEqual(resolveExport('icons.ts', 'ChevronDownIcon', t), {
    target: 'icons.ts',
    external: true,
  });
});

test('export * from an npm package is treated as external, not untraced', () => {
  const t = new Map([['bridge.ts', table({ local: ['localThing'], hasExternalStar: true })]]);
  const hit = resolveExport('bridge.ts', 'createChat', t);
  assert.equal(hit?.external, true);
  // A locally defined name still wins over the external star.
  assert.deepEqual(resolveExport('bridge.ts', 'localThing', t), { target: 'bridge.ts' });
});

test('a name that exists nowhere returns null so the caller can fall back', () => {
  const t = new Map([
    ['index.ts', table({ stars: ['impl.ts'] })],
    ['impl.ts', table({ local: ['other'] })],
  ]);
  assert.equal(resolveExport('index.ts', 'missing', t), null);
});

test('cyclic re-exports terminate instead of hanging', () => {
  const t = new Map([
    ['a.ts', table({ stars: ['b.ts'] })],
    ['b.ts', table({ stars: ['a.ts'] })],
  ]);
  assert.equal(resolveExport('a.ts', 'anything', t), null);
});

test('a file outside the scanned set resolves to null', () => {
  const t = new Map([['index.ts', table({ named: { X: ['not-scanned.ts', 'X'] } })]]);
  assert.equal(resolveExport('index.ts', 'X', t), null);
});

test('namespace re-export terminates at the module', () => {
  // index.ts: export * as ns from './ns'  ->  named ns -> ['ns.ts', '*']
  const t = new Map([
    ['index.ts', table({ named: { ns: ['ns.ts', '*'] } })],
    ['ns.ts', table({ local: ['a', 'b'] })],
  ]);
  assert.deepEqual(resolveExport('index.ts', 'ns', t), {
    target: 'ns.ts',
    viaBarrel: 'index.ts',
  });
});

test('the first matching star wins, in source order', () => {
  const t = new Map([
    ['index.ts', table({ stars: ['first.ts', 'second.ts'] })],
    ['first.ts', table({ local: ['dup'] })],
    ['second.ts', table({ local: ['dup'] })],
  ]);
  assert.equal(resolveExport('index.ts', 'dup', t)?.target, 'first.ts');
});
