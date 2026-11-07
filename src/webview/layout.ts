import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export const NODE_W = 208;
export const NODE_H = 46;
const RANK_GAP = 90;
const NODE_GAP = 18;

export type XY = { x: number; y: number };

/**
 * Full left-to-right layered layout via dagre (MIT, actively maintained).
 *
 * elkjs was rejected: 1.4MB vs dagre's ~40KB, and EPL-2.0/GPL-3.0 which is the
 * wrong licence to ship inside an extension. d3-force was rejected because
 * non-deterministic positions fight the user's own dragging.
 *
 * Used for the first render of an anchor and for the explicit "Re-layout"
 * action. Expanding a node uses `grow` instead, so the view never jumps.
 */
export function layout(
  nodes: Node[],
  edges: Edge[],
  pinned: Record<string, XY> = {},
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_GAP, ranksep: RANK_GAP, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) {
    // dagre throws on an edge to a node it does not know about.
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const saved = pinned[n.id];
    if (saved) return { ...n, position: saved };
    const p = g.node(n.id);
    // dagre returns centre points; React Flow positions by top-left corner.
    return p ? { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } } : n;
  });
}

function overlaps(a: XY, b: XY): boolean {
  return (
    Math.abs(a.x - b.x) < NODE_W + NODE_GAP / 2 &&
    Math.abs(a.y - b.y) < NODE_H + NODE_GAP / 2
  );
}

/**
 * Additive layout for expansion.
 *
 * Every node already on screen keeps its exact position, so expanding a branch
 * never rearranges what the user is looking at - it only grows. New nodes are
 * placed one rank to the right of the parent that revealed them (or to the left
 * when the edge runs the other way), stacked around the parent's vertical
 * centre and nudged down out of anything already occupying the space.
 */
export function grow(
  nodes: Node[],
  edges: Edge[],
  existing: Record<string, XY>,
): Node[] {
  // Nothing on screen yet: there is no arrangement to preserve.
  const anyKnown = nodes.some((n) => existing[n.id]);
  if (!anyKnown) return layout(nodes, edges, {});

  const placed = new Map<string, XY>();
  const fresh: Node[] = [];
  for (const n of nodes) {
    const p = existing[n.id];
    if (p) placed.set(n.id, p);
    else fresh.push(n);
  }
  if (fresh.length === 0) {
    return nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position }));
  }

  // Which already-placed node revealed each new one, and on which side.
  const parentOf = new Map<string, { id: string; side: 1 | -1 }>();
  for (const e of edges) {
    if (placed.has(e.source) && !placed.has(e.target) && !parentOf.has(e.target)) {
      parentOf.set(e.target, { id: e.source, side: 1 });
    } else if (placed.has(e.target) && !placed.has(e.source) && !parentOf.has(e.source)) {
      parentOf.set(e.source, { id: e.target, side: -1 });
    }
  }

  // Group siblings so they fan out around their shared parent.
  const byParent = new Map<string, Node[]>();
  const orphans: Node[] = [];
  for (const n of fresh) {
    const parent = parentOf.get(n.id);
    if (!parent) { orphans.push(n); continue; }
    const key = `${parent.id}\0${parent.side}`;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }

  const free = (pos: XY): XY => {
    // ponytail: linear scan against placed nodes. Fine to a few hundred nodes;
    // swap in a grid index if expansion ever needs to handle thousands.
    let p = pos;
    let guard = 0;
    while ([...placed.values()].some((q) => overlaps(p, q)) && guard++ < 500) {
      p = { x: p.x, y: p.y + NODE_H + NODE_GAP };
    }
    return p;
  };

  const out = new Map<string, XY>();

  for (const [key, siblings] of byParent) {
    const [parentId, sideStr] = key.split('\0');
    const side = Number(sideStr) as 1 | -1;
    const anchor = placed.get(parentId)!;
    const x = anchor.x + side * (NODE_W + RANK_GAP);
    const span = (siblings.length - 1) * (NODE_H + NODE_GAP);
    let y = anchor.y - span / 2;

    for (const n of siblings) {
      const pos = free({ x, y });
      placed.set(n.id, pos);
      out.set(n.id, pos);
      y = pos.y + NODE_H + NODE_GAP;
    }
  }

  // No visible parent (filters, or an edge we did not keep): park it to the
  // right of everything rather than at the origin, where it would overlap.
  if (orphans.length > 0) {
    const maxX = Math.max(...[...placed.values()].map((p) => p.x), 0);
    let y = 0;
    for (const n of orphans) {
      const pos = free({ x: maxX + NODE_W + RANK_GAP, y });
      placed.set(n.id, pos);
      out.set(n.id, pos);
      y = pos.y + NODE_H + NODE_GAP;
    }
  }

  return nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position }));
}
