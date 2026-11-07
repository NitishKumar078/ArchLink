import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explore, branchFrom, type ExploredGraph } from './query.ts';
import type { Edge, Graph, GraphNode, Category } from './types.ts';

/**
 *   page -> card -> useUser -> service -> api
 *   other -> card
 *   page -> (unresolved)
 *   island (unconnected)
 */
function fixture(): Graph {
  const mk = (id: string, category: Category): GraphNode => ({
    id, label: id, category, exports: [],
  });
  const nodes = new Map<string, GraphNode>([
    ['page.tsx', mk('page.tsx', 'route')],
    ['card.tsx', mk('card.tsx', 'component')],
    ['other.tsx', mk('other.tsx', 'component')],
    ['useUser.ts', mk('useUser.ts', 'hook')],
    ['service.ts', mk('service.ts', 'module')],
    ['api.ts', mk('api.ts', 'module')],
    ['island.ts', mk('island.ts', 'module')],
  ]);
  const e = (from: string, to: string | null): Edge => ({
    from, to, specifier: to ?? './missing', kind: 'imports',
    confidence: 'high', at: { line: 1, character: 0 },
  });
  const edges: Edge[] = [
    e('page.tsx', 'card.tsx'),
    e('other.tsx', 'card.tsx'),
    e('card.tsx', 'useUser.ts'),
    e('useUser.ts', 'service.ts'),
    e('service.ts', 'api.ts'),
    e('page.tsx', null),
  ];
  const dependents = new Map<string, Set<string>>();
  for (const x of edges) {
    if (!x.to) continue;
    const s = dependents.get(x.to) ?? new Set();
    s.add(x.from);
    dependents.set(x.to, s);
  }
  return { root: '/p', nodes, edges, dependents, diagnostics: {} as never };
}

const ids = (g: ExploredGraph) => g.nodes.map((n) => n.id).sort();
const byId = (g: ExploredGraph, id: string) => g.nodes.find((n) => n.id === id);

const open = (...xs: string[]) => new Set(xs);

// ------------------------------------------------------------ initial state

test('with nothing expanded, the anchor and its direct neighbours show', () => {
  const g = explore(fixture(), { anchor: 'page.tsx', expanded: open(), direction: 'out' });
  assert.deepEqual(ids(g), ['card.tsx', 'page.tsx']);
});

test('the anchor is always treated as expanded', () => {
  const g = explore(fixture(), { anchor: 'page.tsx', expanded: open(), direction: 'out' });
  assert.equal(byId(g, 'page.tsx')?.isExpanded, true);
});

test('a neighbour starts collapsed and reports how much it hides', () => {
  const g = explore(fixture(), { anchor: 'page.tsx', expanded: open(), direction: 'out' });
  const card = byId(g, 'card.tsx');
  assert.equal(card?.isExpanded, false);
  assert.equal(card?.collapsed, 1, 'card hides useUser');
});

// --------------------------------------------------------------- expansion

test('expanding a node reveals exactly its neighbours, one step', () => {
  const f = fixture();
  const g = explore(f, { anchor: 'page.tsx', expanded: open('card.tsx'), direction: 'out' });
  assert.deepEqual(ids(g), ['card.tsx', 'page.tsx', 'useUser.ts']);
  // The newly revealed node is itself collapsed - no runaway cascade.
  assert.equal(byId(g, 'useUser.ts')?.collapsed, 1);
  assert.equal(byId(g, 'useUser.ts')?.isExpanded, false);
});

test('expanding step by step walks the chain', () => {
  const f = fixture();
  const g = explore(f, {
    anchor: 'page.tsx',
    expanded: open('card.tsx', 'useUser.ts', 'service.ts'),
    direction: 'out',
  });
  assert.deepEqual(ids(g), ['api.ts', 'card.tsx', 'page.tsx', 'service.ts', 'useUser.ts']);
});

test('a fully expanded leaf reports nothing collapsed', () => {
  const g = explore(fixture(), {
    anchor: 'page.tsx',
    expanded: open('card.tsx', 'useUser.ts', 'service.ts', 'api.ts'),
    direction: 'out',
  });
  assert.equal(byId(g, 'api.ts')?.collapsed, 0);
});

test('collapsing a node hides everything only reachable through it', () => {
  const f = fixture();
  const all = open('card.tsx', 'useUser.ts', 'service.ts');
  assert.equal(explore(f, { anchor: 'page.tsx', expanded: all, direction: 'out' }).nodes.length, 5);
  // Drop card from the expanded set; its whole branch must disappear.
  all.delete('card.tsx');
  assert.deepEqual(
    ids(explore(f, { anchor: 'page.tsx', expanded: all, direction: 'out' })),
    ['card.tsx', 'page.tsx'],
  );
});

test('expanding an unrelated node does not reveal it', () => {
  const g = explore(fixture(), {
    anchor: 'page.tsx', expanded: open('island.ts'), direction: 'out',
  });
  assert.ok(!ids(g).includes('island.ts'));
});

// --------------------------------------------------------------- direction

test('incoming direction answers "what breaks if I change this"', () => {
  const g = explore(fixture(), { anchor: 'card.tsx', expanded: open(), direction: 'in' });
  assert.deepEqual(ids(g), ['card.tsx', 'other.tsx', 'page.tsx']);
});

test('both directions combine dependencies and dependents', () => {
  const g = explore(fixture(), { anchor: 'card.tsx', expanded: open(), direction: 'both' });
  assert.deepEqual(ids(g), ['card.tsx', 'other.tsx', 'page.tsx', 'useUser.ts']);
});

test('collapsed counts respect the active direction', () => {
  const out = explore(fixture(), { anchor: 'card.tsx', expanded: open(), direction: 'out' });
  assert.equal(byId(out, 'card.tsx')?.collapsed, 0, 'all outgoing neighbours already shown');
});

// ------------------------------------------------------- unresolved + filters

test('an unresolved edge stays visible on the expanded node that owns it', () => {
  const g = explore(fixture(), { anchor: 'page.tsx', expanded: open(), direction: 'out' });
  assert.equal(g.edges.filter((e) => e.to === null).length, 1);
});

test('category filter prunes traversal but never hides the anchor', () => {
  const g = explore(fixture(), {
    anchor: 'page.tsx',
    expanded: open('card.tsx'),
    direction: 'out',
    categories: new Set<Category>(['component']),
  });
  // useUser is a hook, so expanding card reveals nothing.
  assert.deepEqual(ids(g), ['card.tsx', 'page.tsx']);
});

test('the anchor survives a filter excluding its own category', () => {
  const g = explore(fixture(), {
    anchor: 'page.tsx', expanded: open(), direction: 'out',
    categories: new Set<Category>(['hook']),
  });
  assert.ok(ids(g).includes('page.tsx'));
});

// -------------------------------------------------------------- correctness

test('every returned edge has both ends present', () => {
  const g = explore(fixture(), {
    anchor: 'card.tsx', expanded: open('useUser.ts'), direction: 'both',
  });
  const present = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    assert.ok(present.has(e.from), `dangling from: ${e.from}`);
    if (e.to !== null) assert.ok(present.has(e.to), `dangling to: ${e.to}`);
  }
});

test('an unknown anchor yields an empty graph instead of throwing', () => {
  const g = explore(fixture(), { anchor: 'nope.ts', expanded: open(), direction: 'both' });
  assert.deepEqual(g.nodes, []);
});

test('a cycle terminates without duplicating nodes', () => {
  const f = fixture();
  f.edges.push({
    from: 'api.ts', to: 'page.tsx', specifier: './page', kind: 'imports',
    confidence: 'high', at: { line: 1, character: 0 },
  });
  const g = explore(f, {
    anchor: 'page.tsx',
    expanded: open('card.tsx', 'useUser.ts', 'service.ts', 'api.ts'),
    direction: 'out',
  });
  assert.equal(new Set(g.nodes.map((n) => n.id)).size, g.nodes.length);
});

test('maxNodes caps runaway expansion and reports it', () => {
  const g = explore(fixture(), {
    anchor: 'page.tsx',
    expanded: open('card.tsx', 'useUser.ts', 'service.ts', 'api.ts'),
    direction: 'both',
    maxNodes: 3,
  });
  assert.equal(g.nodes.length, 3);
  assert.equal(g.wasTruncated, true);
});

// ------------------------------------------------------------- branchFrom

test('branchFrom returns the whole downstream branch for recursive expand', () => {
  const b = branchFrom(fixture(), 'card.tsx', 'out');
  assert.deepEqual(b.sort(), ['api.ts', 'card.tsx', 'service.ts', 'useUser.ts']);
});

test('branchFrom honours the node limit', () => {
  assert.equal(branchFrom(fixture(), 'page.tsx', 'out', undefined, 2).length, 2);
});

test('branchFrom honours category filters', () => {
  const b = branchFrom(fixture(), 'page.tsx', 'out', new Set<Category>(['component']));
  assert.deepEqual(b.sort(), ['card.tsx', 'page.tsx']);
});

test('branchFrom on an unknown node is empty', () => {
  assert.deepEqual(branchFrom(fixture(), 'nope.ts', 'out'), []);
});

// ------------------------------------------ shared dependencies / cross-links

/** anchor -> a, anchor -> b, and BOTH a and b import shared.ts */
function shared(): Graph {
  const mk = (id: string, category: Category): GraphNode => ({ id, label: id, category, exports: [] });
  const nodes = new Map<string, GraphNode>([
    ['anchor.tsx', mk('anchor.tsx', 'route')],
    ['a.tsx', mk('a.tsx', 'component')],
    ['b.tsx', mk('b.tsx', 'component')],
    ['shared.ts', mk('shared.ts', 'module')],
  ]);
  const e = (from: string, to: string): Edge => ({
    from, to, specifier: to, kind: 'imports', confidence: 'high', at: { line: 1, character: 0 },
  });
  const edges = [e('anchor.tsx', 'a.tsx'), e('anchor.tsx', 'b.tsx'), e('a.tsx', 'shared.ts'), e('b.tsx', 'shared.ts')];
  return { root: '/p', nodes, edges, dependents: new Map(), diagnostics: {} as never };
}

test('a shared dependency connects to every visible parent, not just the one that revealed it', () => {
  // Expand only a. shared.ts appears through a, but b imports it too and b is
  // on screen - that edge is the whole point of drawing a graph.
  const g = explore(shared(), { anchor: 'anchor.tsx', expanded: open('a.tsx'), direction: 'out' });
  assert.ok(ids(g).includes('shared.ts'));
  const intoShared = g.edges.filter((e) => e.to === 'shared.ts').map((e) => e.from).sort();
  assert.deepEqual(intoShared, ['a.tsx', 'b.tsx']);
});

test('the sibling is not expanded just because it shares a dependency', () => {
  const g = explore(shared(), { anchor: 'anchor.tsx', expanded: open('a.tsx'), direction: 'out' });
  assert.equal(byId(g, 'b.tsx')?.isExpanded, false);
  // ...and it no longer counts shared.ts as hidden, since it is on screen.
  assert.equal(byId(g, 'b.tsx')?.collapsed, 0);
});

test('a back-edge between two visible nodes is drawn, revealing the cycle', () => {
  const f = shared();
  f.edges.push({
    from: 'shared.ts', to: 'a.tsx', specifier: './a', kind: 'imports',
    confidence: 'high', at: { line: 9, character: 0 },
  });
  const g = explore(f, { anchor: 'anchor.tsx', expanded: open('a.tsx'), direction: 'out' });
  assert.ok(
    g.edges.some((e) => e.from === 'shared.ts' && e.to === 'a.tsx'),
    'the cycle edge must be visible',
  );
});

test('edges to nodes that are not visible are still excluded', () => {
  const g = explore(shared(), { anchor: 'anchor.tsx', expanded: open(), direction: 'out' });
  assert.ok(!ids(g).includes('shared.ts'));
  assert.ok(g.edges.every((e) => e.to !== 'shared.ts'));
});
