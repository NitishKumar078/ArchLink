import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, MarkerType,
  useNodesState, useEdgesState, useReactFlow, ReactFlowProvider,
  type Node, type Edge, type NodeChange,
} from '@xyflow/react';
import { FileNode, type FileNodeData } from './FileNode.tsx';
import { layout, grow, type XY } from './layout.ts';
import { CATEGORY_STYLES, edgeStyle, styleFor } from './theme.ts';
import type { ToWebview, FromWebview, ViewState, GraphStats } from '../protocol.ts';
import type { Category } from '../analyzer/types.ts';
import type { ExploredGraph } from '../analyzer/query.ts';

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const nodeTypes = { file: FileNode };

interface Handlers {
  onExpand: (id: string) => void;
  onCollapse: (id: string) => void;
  onExpandBranch: (id: string) => void;
}

function buildFlow(
  g: ExploredGraph,
  hidden: Set<Category>,
  search: string,
  handlers: Handlers,
): { nodes: Node[]; edges: Edge[] } {
  const visible = new Set(
    g.nodes.filter((n) => n.id === g.anchor || !hidden.has(n.category)).map((n) => n.id),
  );
  const q = search.trim().toLowerCase();

  const nodes: Node[] = g.nodes
    .filter((n) => visible.has(n.id))
    .map((n) => ({
      id: n.id,
      type: 'file',
      position: { x: 0, y: 0 },
      data: {
        label: n.label,
        path: n.id,
        category: n.category,
        isAnchor: n.id === g.anchor,
        routePath: n.routePath,
        directive: n.directive,
        // Search dims rather than removes, so the graph keeps its shape.
        dimmed: q.length > 0 && !n.id.toLowerCase().includes(q),
        collapsed: n.collapsed,
        isExpanded: n.isExpanded,
        ...handlers,
      } satisfies FileNodeData as unknown as Record<string, unknown>,
    }));

  const edges: Edge[] = [];
  let danglingSeq = 0;

  for (const e of g.edges) {
    if (e.to === null) {
      // Synthesise a terminal node: an unresolved import must stay visible.
      if (!visible.has(e.from)) continue;
      const id = `unresolved:${danglingSeq++}`;
      nodes.push({
        id,
        type: 'file',
        position: { x: 0, y: 0 },
        data: {
          label: e.specifier, path: e.specifier, category: 'module',
          isAnchor: false, dimmed: false, unresolved: true,
          collapsed: 0, isExpanded: false, ...handlers,
        } satisfies FileNodeData as unknown as Record<string, unknown>,
      });
      const st = edgeStyle(e.kind, true);
      edges.push({
        id: `e${danglingSeq}-${e.from}-${id}`,
        source: e.from, target: id,
        style: { stroke: st.stroke, strokeWidth: st.width, strokeDasharray: st.dash },
        label: e.unanalyzable ? 'undecidable' : 'unresolved',
        labelStyle: { fill: st.stroke, fontSize: 9 },
        labelBgStyle: { fill: 'var(--vscode-editor-background)' },
      });
      continue;
    }
    if (!visible.has(e.from) || !visible.has(e.to)) continue;

    const st = edgeStyle(e.kind, false);
    const renders = !!e.badges?.renders;
    const viaBarrel = e.badges?.viaBarrel;
    edges.push({
      id: `e-${e.from}-${e.to}-${e.kind}-${e.at.line}`,
      source: e.from,
      target: e.to,
      animated: e.kind === 'dynamic-imports',
      style: {
        stroke: renders ? styleFor('component').color : st.stroke,
        strokeWidth: renders ? st.width + 0.9 : st.width,
        strokeDasharray: st.dash,
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14,
        color: renders ? styleFor('component').color : st.stroke },
      label: viaBarrel ? 'via barrel' : renders ? 'renders' : undefined,
      labelStyle: { fontSize: 9, fill: 'var(--vscode-descriptionForeground)' },
      labelBgStyle: { fill: 'var(--vscode-editor-background)', fillOpacity: 0.85 },
      data: { line: e.at.line, character: e.at.character, from: e.from },
    });
  }

  return { nodes, edges };
}

function Graph() {
  const [g, setG] = useState<ExploredGraph | null>(null);
  const [state, setState] = useState<ViewState | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [available, setAvailable] = useState<Category[]>([]);
  const [status, setStatus] = useState('Analyzing project...');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hidden, setHidden] = useState<Set<Category>>(new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  /** Current on-screen position of every node, so expanding never moves them. */
  const positionsRef = useRef<Record<string, XY>>({});
  /** Positions the user dragged; these also survive an explicit Re-layout. */
  const draggedRef = useRef<Record<string, XY>>({});
  const anchorRef = useRef<string | null>(null);
  const didFitRef = useRef(false);
  const { fitView, getZoom } = useReactFlow();
  /** The node the user last opened, so the view can follow what they clicked. */
  const focusRef = useRef<string | null>(null);

  const handlers = useMemo<Handlers>(() => ({
    onExpand: (id) => { focusRef.current = id; post({ type: 'expand', id }); },
    onCollapse: (id) => { focusRef.current = id; post({ type: 'collapse', id }); },
    onExpandBranch: (id) => { focusRef.current = id; post({ type: 'expandBranch', id }); },
  }), []);

  // --- messages from the extension
  useEffect(() => {
    const onMessage = (ev: MessageEvent<ToWebview>) => {
      const msg = ev.data;
      if (msg.type === 'status') { setStatus(msg.text); return; }
      if (msg.type === 'error') { setError(msg.message); return; }
      if (msg.type === 'graph') {
        setError(null);
        setG(msg.graph);
        setState(msg.state);
        setStats(msg.stats);
        setAvailable(msg.availableCategories);
        setHidden(new Set(msg.state.hidden));
        // A new anchor is a new exploration, so start its arrangement fresh.
        if (anchorRef.current !== msg.graph.anchor) {
          anchorRef.current = msg.graph.anchor;
          draggedRef.current = msg.positions ?? {};
          positionsRef.current = { ...(msg.positions ?? {}) };
          didFitRef.current = false;
        }
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // --- rebuild + lay out whenever the data or the filters change
  useEffect(() => {
    if (!g) return;
    const flow = buildFlow(g, hidden, search, handlers);
    // Additive: everything already on screen keeps its position, so expanding
    // a node grows the picture instead of rearranging it.
    const positioned = grow(flow.nodes, flow.edges, positionsRef.current);
    const next: Record<string, XY> = {};
    for (const n of positioned) {
      if (!n.id.startsWith('unresolved:')) next[n.id] = n.position;
    }
    positionsRef.current = next;

    setNodes(positioned);
    setEdges(flow.edges);
    // Frame the whole graph only on an anchor's first render. After that,
    // follow what the user just opened: pan to the clicked node and whatever
    // appeared next to it, at the current zoom, so the view neither jumps nor
    // leaves the new nodes off-screen.
    const focus = focusRef.current;
    focusRef.current = null;

    if (!didFitRef.current) {
      didFitRef.current = true;
      const t = setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 60);
      return () => clearTimeout(t);
    }

    if (focus) {
      const revealed = new Set<string>([focus]);
      for (const e of flow.edges) {
        if (e.source === focus) revealed.add(e.target);
        if (e.target === focus) revealed.add(e.source);
      }
      const zoom = getZoom();
      const t = setTimeout(() => {
        void fitView({
          nodes: [...revealed].map((id) => ({ id })),
          padding: 0.35,
          duration: 400,
          // Locking both bounds to the current zoom makes this a pan, not a
          // zoom - the user's chosen scale is theirs to keep.
          minZoom: zoom,
          maxZoom: zoom,
        });
      }, 60);
      return () => clearTimeout(t);
    }
  }, [g, hidden, search, handlers, setNodes, setEdges, fitView, getZoom]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      onNodesChange(changes);
      // Persist only when a drag finishes, not on every intermediate frame.
      const settled = changes.some(
        (c) => c.type === 'position' && (c as { dragging?: boolean }).dragging === false,
      );
      if (!settled || !g) return;
      setNodes((cur) => {
        const next = { ...positionsRef.current };
        const dragged = { ...draggedRef.current };
        for (const n of cur) {
          if (n.id.startsWith('unresolved:')) continue;
          next[n.id] = n.position;
          dragged[n.id] = n.position;
        }
        positionsRef.current = next;
        draggedRef.current = dragged;
        post({ type: 'savePositions', anchor: g.anchor, positions: dragged });
        return cur;
      });
    },
    [onNodesChange, setNodes, g],
  );

  const relayout = useCallback(() => {
    if (!g) return;
    draggedRef.current = {};
    post({ type: 'savePositions', anchor: g.anchor, positions: {} });
    const flow = buildFlow(g, hidden, search, handlers);
    const positioned = layout(flow.nodes, flow.edges, {});
    const next: Record<string, XY> = {};
    for (const n of positioned) {
      if (!n.id.startsWith('unresolved:')) next[n.id] = n.position;
    }
    positionsRef.current = next;
    setNodes(positioned);
    setEdges(flow.edges);
    setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 60);
  }, [g, hidden, search, handlers, setNodes, setEdges, fitView]);

  const toggleCategory = (c: Category) => {
    const next = new Set(hidden);
    next.has(c) ? next.delete(c) : next.add(c);
    setHidden(next);
    post({ type: 'requery', state: { hidden: [...next] } });
  };

  const legend = useMemo(
    () => available.filter((c) => c in CATEGORY_STYLES),
    [available],
  );

  if (error) {
    return (
      <div className="splash">
        <h2>Analysis failed</h2>
        <pre className="splash__err">{error}</pre>
        <button onClick={() => post({ type: 'reanalyze' })}>Retry</button>
      </div>
    );
  }

  if (!g || !state) {
    return <div className="splash"><div className="spinner" /><p>{status}</p></div>;
  }

  if (g.nodes.length === 0) {
    return (
      <div className="splash">
        <h2>Nothing to show</h2>
        <p>{g.anchor} was not found in the analyzed file set.</p>
        <button onClick={() => post({ type: 'reanalyze' })}>Re-analyze</button>
      </div>
    );
  }

  const openCount = state.expanded.length;
  const stillHidden = g.nodes.reduce((sum, n) => sum + n.collapsed, 0);

  return (
    <div className="wrap">
      <div className="toolbar">
        <button
          className="anchor"
          title={`Open ${g.anchor}`}
          onClick={() => post({ type: 'openFile', id: g.anchor })}
        >
          <span className="anchor__icon">◎</span>
          {g.anchor}
        </button>

        <div className="group" role="group" aria-label="Direction">
          {(['out', 'in', 'both'] as const).map((d) => (
            <button
              key={d}
              className={state.direction === d ? 'on' : ''}
              title={
                d === 'out' ? 'What this file pulls in'
                : d === 'in' ? 'What would break if this changed'
                : 'Both directions'
              }
              onClick={() => post({ type: 'requery', state: { direction: d } })}
            >
              {d === 'out' ? 'Uses →' : d === 'in' ? '← Used by' : '↔ Both'}
            </button>
          ))}
        </div>

        <button
          onClick={() => post({ type: 'expandBranch', id: g.anchor })}
          title="Expand every branch below the anchor (capped)"
        >
          Expand all
        </button>
        <button
          onClick={() => post({ type: 'collapseAll' })}
          disabled={openCount === 0}
          title="Collapse back to the anchor and its direct neighbours"
        >
          Collapse all
        </button>

        <input
          className="search"
          type="search"
          placeholder="dim non-matching..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <button onClick={relayout} title="Discard dragged positions and re-run layout">
          Re-layout
        </button>
        <button onClick={() => post({ type: 'reanalyze' })} title="Re-scan the workspace">
          Re-analyze
        </button>
      </div>

      <div className="legend">
        {legend.map((c) => {
          const s = styleFor(c);
          const off = hidden.has(c);
          return (
            <button
              key={c}
              className={`chip ${off ? 'chip--off' : ''}`}
              style={{ '--cat': s.color } as React.CSSProperties}
              onClick={() => toggleCategory(c)}
              title={off ? `Show ${s.label}` : `Hide ${s.label}`}
            >
              <span className="chip__dot" />
              {s.icon} {s.label}
            </button>
          );
        })}
      </div>

      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          // Keeps large graphs responsive: only visible nodes are rendered.
          onlyRenderVisibleElements
          minZoom={0.1}
          maxZoom={2.5}
          onNodeClick={(_, n) => {
            if (n.id.startsWith('unresolved:')) return;
            post({ type: 'openFile', id: n.id });
          }}
          onNodeDoubleClick={(_, n) => {
            if (n.id.startsWith('unresolved:')) return;
            post({ type: 'setAnchor', id: n.id });
          }}
          onEdgeClick={(_, e) => {
            const d = e.data as { from?: string; line?: number; character?: number } | undefined;
            if (d?.from) post({ type: 'openFile', id: d.from, line: d.line, character: d.character });
          }}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
        </ReactFlow>
      </div>

      <div className="statusbar">
        <span><b>{g.nodes.length}</b> shown of {g.totalNodesInProject} files</span>
        <span><b>{g.edges.length}</b> edges</span>
        <span>{openCount} expanded</span>
        {stillHidden > 0 ? <span className="dim">{stillHidden} collapsed</span> : null}
        {stats ? (
          <>
            <span>{stats.barrelChains} barrel chains</span>
            <span className={stats.unresolvedEdges ? 'warn' : ''}>
              {stats.unresolvedEdges} unresolved
            </span>
            <span className="dim">scan {stats.analysisMs}ms</span>
          </>
        ) : null}
        {g.wasTruncated ? (
          <span className="warn" title="Expansion cap reached - collapse a branch or filter categories">
            capped at {g.nodes.length} nodes
          </span>
        ) : null}
        {stats?.isMonorepo ? (
          <span className="warn" title={stats.monorepoReason}>
            monorepo - cross-package imports unsupported
          </span>
        ) : null}
        <span className="dim hint">
          + = expand · shift+ = whole branch · click = open · dbl-click = re-centre
        </span>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Graph />
    </ReactFlowProvider>
  );
}
