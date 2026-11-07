/** Messages crossing the extension/webview boundary. Shared by both sides. */
import type { Category } from './analyzer/types.ts';
import type { ExploredGraph, Direction } from './analyzer/query.ts';

export interface GraphStats {
  filesScanned: number;
  resolvedEdges: number;
  unresolvedEdges: number;
  undecidable: number;
  barrelChains: number;
  isMonorepo: boolean;
  monorepoReason?: string;
  analysisMs: number;
}

export interface ViewState {
  anchor: string;
  /** Nodes the user has opened. The anchor is always implicitly expanded. */
  expanded: string[];
  direction: Direction;
  /** Hidden categories; empty means show everything. */
  hidden: Category[];
}

/** Extension -> webview. */
export type ToWebview =
  | { type: 'status'; text: string }
  | {
      type: 'graph';
      graph: ExploredGraph;
      state: ViewState;
      stats: GraphStats;
      /** Saved node positions for this anchor, if the user has dragged before. */
      positions: Record<string, { x: number; y: number }>;
      /** Every category present in the project, for building the filter UI. */
      availableCategories: Category[];
    }
  | { type: 'error'; message: string };

/** Webview -> extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  /** Expand this node and everything below it in one action. */
  | { type: 'expandBranch'; id: string }
  | { type: 'collapseAll' }
  | { type: 'requery'; state: Partial<Pick<ViewState, 'direction' | 'hidden'>> }
  | { type: 'openFile'; id: string; line?: number; character?: number }
  | { type: 'setAnchor'; id: string }
  | { type: 'savePositions'; anchor: string; positions: Record<string, { x: number; y: number }> }
  | { type: 'reanalyze' };
