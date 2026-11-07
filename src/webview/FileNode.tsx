import { Handle, Position, type NodeProps } from '@xyflow/react';
import { styleFor } from './theme.ts';
import type { Category } from '../analyzer/types.ts';

export interface FileNodeData {
  label: string;
  path: string;
  category: Category;
  isAnchor: boolean;
  routePath?: string;
  directive?: 'use client' | 'use server';
  dimmed: boolean;
  unresolved?: boolean;
  /** Neighbours not on screen. 0 means this node is a true leaf. */
  collapsed: number;
  isExpanded: boolean;
  onExpand: (id: string) => void;
  onCollapse: (id: string) => void;
  onExpandBranch: (id: string) => void;
}

export function FileNode({ data, selected }: NodeProps) {
  const d = data as unknown as FileNodeData;

  if (d.unresolved) {
    return (
      <div className="node node--unresolved" title={`Could not resolve: ${d.label}`}>
        <Handle type="target" position={Position.Left} />
        <span className="node__icon">?</span>
        <span className="node__label">{d.label}</span>
      </div>
    );
  }

  const s = styleFor(d.category);
  const canExpand = d.collapsed > 0;
  const canCollapse = d.isExpanded && !d.isAnchor;

  const classes = [
    'node',
    `node--${s.shape}`,
    d.isAnchor ? 'node--anchor' : '',
    selected ? 'node--selected' : '',
    d.dimmed ? 'node--dimmed' : '',
    canExpand ? 'node--has-more' : '',
  ].filter(Boolean).join(' ');

  // The toggle sits inside the node, so its clicks must not reach the node's
  // own click handler (which opens the file).
  const stop = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); };

  return (
    <div
      className={classes}
      style={{ '--cat': s.color } as React.CSSProperties}
      title={`${d.path}\n${s.label}${d.routePath ? ` · ${d.routePath}` : ''}${
        canExpand ? `\n${d.collapsed} more hidden - click + to expand` : ''
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <span className="node__icon" aria-hidden="true">{s.icon}</span>

      <span className="node__text">
        <span className="node__label">{d.label}</span>
        {d.routePath ? <span className="node__sub">{d.routePath}</span> : null}
      </span>

      {d.directive === 'use client' ? <span className="node__flag" title="use client">C</span> : null}
      {d.directive === 'use server' ? <span className="node__flag" title="use server">S</span> : null}

      {canExpand ? (
        <button
          className="node__toggle"
          title={`Expand ${d.collapsed} hidden · shift-click to expand the whole branch`}
          aria-label={`Expand ${d.collapsed} hidden dependencies`}
          onMouseDown={stop}
          onClick={(e) => {
            stop(e);
            if (e.shiftKey) d.onExpandBranch(d.path);
            else d.onExpand(d.path);
          }}
        >
          +{d.collapsed}
        </button>
      ) : canCollapse ? (
        <button
          className="node__toggle node__toggle--close"
          title="Collapse this branch"
          aria-label="Collapse this branch"
          onMouseDown={stop}
          onClick={(e) => { stop(e); d.onCollapse(d.path); }}
        >
          −
        </button>
      ) : null}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
