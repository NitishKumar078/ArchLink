/** Node categories. Framework-specific ones come first; `module` is the fallback. */
export type Category =
  | 'route'          // app/**/page.tsx, pages/**/*.tsx
  | 'layout'         // layout.tsx, template.tsx, _app, _document
  | 'route-handler'  // app/**/route.ts, pages/api/**
  | 'route-special'  // loading, error, not-found, default, forbidden, unauthorized
  | 'proxy'          // proxy.ts (Next 16+) and legacy middleware.ts
  | 'component'      // exports a React component
  | 'hook'           // exports a use* hook
  | 'context'        // calls createContext
  | 'type'           // .d.ts or type-only exports
  | 'config'         // *.config.*, instrumentation, mdx-components
  | 'test'           // *.test.*, *.spec.*
  | 'barrel'         // index file that only re-exports
  | 'module'         // services, utils, libs - the honest fallback
  | 'external';      // bare package specifier

export type EdgeKind =
  | 'imports'
  | 'imports-type'
  | 'reexports'
  | 'dynamic-imports'
  | 'requires';

/** Uncertain analysis decorates certain analysis. These never replace an edge kind. */
export interface EdgeBadges {
  /** An imported binding is used as a JSX element name in the importing file. */
  renders?: boolean;
  /** Resolved through a barrel/re-export chain; value is the barrel's node id. */
  viaBarrel?: string;
}

export interface Edge {
  from: string;
  /** Node id, or null when the specifier could not be resolved. */
  to: string | null;
  /** Always present — the raw specifier, so unresolved edges stay inspectable. */
  specifier: string;
  kind: EdgeKind;
  confidence: 'high' | 'medium';
  /** 1-based line, 0-based character — click-to-navigate target. */
  at: { line: number; character: number };
  badges?: EdgeBadges;
  /** Specifier was not a string literal: statically undecidable, not a failure. */
  unanalyzable?: boolean;
}

export interface GraphNode {
  /** Workspace-relative POSIX path. Identity is the path, so duplicates are impossible. */
  id: string;
  label: string;
  category: Category;
  router?: 'app' | 'pages';
  /** Derived URL path for routes, e.g. '/dashboard/[id]'. */
  routePath?: string;
  directive?: 'use client' | 'use server';
  exports: string[];
  hasSyntaxError?: boolean;
}

export interface Graph {
  root: string;
  nodes: Map<string, GraphNode>;
  edges: Edge[];
  /** node id -> ids of nodes importing it. */
  dependents: Map<string, Set<string>>;
  diagnostics: Diagnostics;
}

export interface Diagnostics {
  filesScanned: number;
  filesSkipped: number;
  syntaxErrors: string[];
  /** specifier -> occurrence count, for unresolved imports only. */
  unresolved: Map<string, number>;
  /** Imports resolved only as far as a barrel file (name not found in its export table). */
  barrelFallbacks: number;
  /** Names correctly traced to an external package re-export. */
  barrelExternal: number;
  /** Dynamic imports whose specifier is not a string literal. */
  unanalyzableImports: number;
  /** Loader-handled imports (css, images, json). Not modules, not failures. */
  assetImports: number;
  barrelResolved: number;
  isMonorepo: boolean;
  monorepoReason?: string;
  tsconfigPath?: string;
  timings: Record<string, number>;
}
