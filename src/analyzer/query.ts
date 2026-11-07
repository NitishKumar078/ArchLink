import type { Category, Edge, Graph, GraphNode } from './types.ts';

export type Direction = 'out' | 'in' | 'both';

export interface ExploreOptions {
  /** Node the view is centred on. Always visible, always expandable. */
  anchor: string;
  /**
   * Nodes whose neighbours are shown. A node not in this set is a leaf in the
   * current view even if it has neighbours - that is the whole point: the user
   * opens branches they care about instead of being handed the transitive
   * closure.
   */
  expanded: Set<string>;
  /** `out` = what this pulls in. `in` = what would break if it changed. */
  direction: Direction;
  /** When set, only these categories are traversed (the anchor always passes). */
  categories?: Set<Category>;
  /** Safety ceiling. Reached only via recursive expansion, not normal clicking. */
  maxNodes?: number;
}

export interface ExploredNode extends GraphNode {
  /** Distance from the anchor through currently-visible nodes. */
  hops: number;
  /** Neighbours that exist but are not on screen - drives the "+N" affordance. */
  collapsed: number;
  isExpanded: boolean;
}

export interface ExploredGraph {
  anchor: string;
  nodes: ExploredNode[];
  edges: Edge[];
  wasTruncated: boolean;
  totalNodesInProject: number;
}

const DEFAULT_MAX_NODES = 400;

/** Outgoing and incoming adjacency, built once per call. */
function adjacency(graph: Graph): {
  out: Map<string, Edge[]>;
  in: Map<string, Edge[]>;
} {
  const out = new Map<string, Edge[]>();
  const inc = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    let o = out.get(e.from);
    if (!o) out.set(e.from, (o = []));
    o.push(e);
    if (e.to !== null) {
      let i = inc.get(e.to);
      if (!i) inc.set(e.to, (i = []));
      i.push(e);
    }
  }
  return { out, in: inc };
}

/** Neighbours of `id` in the requested direction, as {edge, other} pairs. */
function neighboursOf(
  id: string,
  direction: Direction,
  adj: ReturnType<typeof adjacency>,
): Array<{ edge: Edge; other: string | null }> {
  const list: Array<{ edge: Edge; other: string | null }> = [];
  if (direction === 'out' || direction === 'both') {
    for (const e of adj.out.get(id) ?? []) list.push({ edge: e, other: e.to });
  }
  if (direction === 'in' || direction === 'both') {
    for (const e of adj.in.get(id) ?? []) list.push({ edge: e, other: e.from });
  }
  return list;
}

/**
 * Progressive exploration: the view grows only where the user opened it.
 *
 * Replaces an earlier depth-N query. A global depth either shows too little or
 * explodes - on dub, depth 2 in both directions hit a 200-node cap and rendered
 * as an unreadable wall. Expanding per node keeps every intermediate state
 * readable and only costs what is actually on screen.
 */
export function explore(graph: Graph, opts: ExploreOptions): ExploredGraph {
  const { anchor, direction } = opts;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;

  const result: ExploredGraph = {
    anchor,
    nodes: [],
    edges: [],
    wasTruncated: false,
    totalNodesInProject: graph.nodes.size,
  };
  if (!graph.nodes.has(anchor)) return result;

  const adj = adjacency(graph);
  const passes = (id: string): boolean =>
    id === anchor || !opts.categories || !!graph.nodes.get(id) && opts.categories.has(graph.nodes.get(id)!.category);

  // The anchor is implicitly expanded, otherwise the view would be a single node.
  const expanded = new Set(opts.expanded);
  expanded.add(anchor);

  // --- walk outward, but only *through* expanded nodes
  const hops = new Map<string, number>([[anchor, 0]]);
  const queue: string[] = [anchor];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (!expanded.has(id)) continue; // a collapsed node is a leaf here

    for (const { other } of neighboursOf(id, direction, adj)) {
      if (other === null) continue; // unresolved: no far end to walk to
      if (!passes(other)) continue;

      if (!hops.has(other)) {
        if (hops.size >= maxNodes) {
          result.wasTruncated = true;
          continue;
        }
        hops.set(other, (hops.get(id) ?? 0) + 1);
        queue.push(other);
      }
    }
  }

  // --- how much is hidden behind each visible node
  for (const [id, h] of hops) {
    const node = graph.nodes.get(id);
    if (!node) continue;

    const hiddenNeighbours = new Set<string>();
    for (const { other } of neighboursOf(id, direction, adj)) {
      if (other !== null && !hops.has(other) && passes(other)) hiddenNeighbours.add(other);
    }

    result.nodes.push({
      ...node,
      hops: h,
      collapsed: hiddenNeighbours.size,
      isExpanded: expanded.has(id),
    });
  }
  result.nodes.sort((a, b) => a.hops - b.hops || a.id.localeCompare(b.id));

  // Every relationship between two visible nodes is drawn, not just the one
  // edge that happened to reveal the node. Otherwise a shared dependency looks
  // like it belongs to a single parent, when the fact that three siblings all
  // import it is the most useful thing the graph can tell you. Back-edges are
  // kept for the same reason: a cycle between visible nodes is worth seeing.
  for (const e of graph.edges) {
    if (e.to === null) {
      // Unresolved imports hang off the node that owns them, and only once
      // that node is expanded - otherwise they are noise on every leaf.
      if (hops.has(e.from) && expanded.has(e.from)) result.edges.push(e);
    } else if (hops.has(e.from) && hops.has(e.to)) {
      result.edges.push(e);
    }
  }

  return result;
}

/**
 * Every node reachable from `from`, for "expand everything below this".
 * Returned ids are meant to be added to the expanded set, so the caller gets
 * the whole branch in one action instead of clicking through it.
 */
export function branchFrom(
  graph: Graph,
  from: string,
  direction: Direction,
  categories?: Set<Category>,
  limit = 400,
): string[] {
  if (!graph.nodes.has(from)) return [];
  const adj = adjacency(graph);
  const seen = new Set<string>([from]);
  const queue = [from];

  while (queue.length > 0 && seen.size < limit) {
    const id = queue.shift()!;
    for (const { other } of neighboursOf(id, direction, adj)) {
      if (other === null || seen.has(other)) continue;
      const n = graph.nodes.get(other);
      if (!n) continue;
      if (categories && !categories.has(n.category)) continue;
      seen.add(other);
      queue.push(other);
      if (seen.size >= limit) break;
    }
  }
  return [...seen];
}

/** Files nothing imports and which import nothing - usually dead or an entry point. */
export function isolatedNodes(graph: Graph): string[] {
  const touched = new Set<string>();
  for (const e of graph.edges) {
    touched.add(e.from);
    if (e.to) touched.add(e.to);
  }
  return [...graph.nodes.keys()].filter((id) => !touched.has(id));
}
