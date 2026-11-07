import type { Category } from '../analyzer/types.ts';

export interface CategoryStyle {
  label: string;
  /** Primary channel. Chosen to hold up on both light and dark editor themes. */
  color: string;
  /** Secondary channel - reads faster than shape at small sizes. */
  icon: string;
  /**
   * Shape is a weak channel for many categories, so it is reserved for the
   * few that benefit from standing out at a glance.
   */
  shape: 'rect' | 'stadium' | 'route' | 'dashed' | 'double';
}

export const CATEGORY_STYLES: Record<Category, CategoryStyle> = {
  route:          { label: 'Route',        color: '#2ea043', icon: '▶', shape: 'route' },
  layout:         { label: 'Layout',       color: '#1f9b8a', icon: '▦', shape: 'route' },
  'route-handler':{ label: 'API route',    color: '#d98020', icon: '⇄', shape: 'route' },
  'route-special':{ label: 'Route state',  color: '#6f8f5a', icon: '○', shape: 'route' },
  proxy:          { label: 'Proxy',        color: '#d1495b', icon: '⚑', shape: 'route' },
  component:      { label: 'Component',    color: '#3b82f6', icon: '▣', shape: 'rect' },
  hook:           { label: 'Hook',         color: '#a855f7', icon: '⚓', shape: 'stadium' },
  context:        { label: 'Context',      color: '#e0a526', icon: '⬡', shape: 'stadium' },
  barrel:         { label: 'Barrel',       color: '#8b9bb4', icon: '≡', shape: 'double' },
  type:           { label: 'Types',        color: '#7d8590', icon: 'Ŧ', shape: 'dashed' },
  module:         { label: 'Module',       color: '#5a7ba6', icon: '◇', shape: 'rect' },
  config:         { label: 'Config',       color: '#a1794e', icon: '⚙', shape: 'dashed' },
  test:           { label: 'Test',         color: '#6b7280', icon: '✓', shape: 'dashed' },
  external:       { label: 'Package',      color: '#8b949e', icon: '☁', shape: 'dashed' },
};

export const UNRESOLVED_COLOR = '#f85149';

export function styleFor(category: Category): CategoryStyle {
  return CATEGORY_STYLES[category] ?? CATEGORY_STYLES.module;
}

/** Edge appearance by kind. `renders` is applied on top as a badge, not a kind. */
export function edgeStyle(kind: string, unresolved: boolean): {
  stroke: string;
  dash?: string;
  width: number;
} {
  if (unresolved) return { stroke: UNRESOLVED_COLOR, dash: '4 3', width: 1.5 };
  switch (kind) {
    case 'imports-type':    return { stroke: '#7d8590', dash: '5 4', width: 1.2 };
    case 'dynamic-imports': return { stroke: '#d98020', dash: '1 4', width: 1.6 };
    case 'reexports':       return { stroke: '#8b9bb4', width: 1.1 };
    case 'requires':        return { stroke: '#8b9bb4', dash: '2 2', width: 1.2 };
    default:                return { stroke: '#6b7f9e', width: 1.5 };
  }
}
