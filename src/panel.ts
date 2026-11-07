import * as vscode from 'vscode';
import * as path from 'node:path';
import { analyze } from './analyzer/index.ts';
import { explore, branchFrom, type Direction } from './analyzer/query.ts';
import type { Graph, Category } from './analyzer/types.ts';
import type { FromWebview, ToWebview, ViewState, GraphStats } from './protocol.ts';

const POSITIONS_KEY = 'archlink.positions.v1';

/** Ceiling for one "expand everything below" action, and for the view overall. */
const BRANCH_LIMIT = 400;

export class GraphPanel {
  private static current: GraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];

  private graph: Graph | undefined;
  private analysisMs = 0;
  private state: ViewState = { anchor: '', expanded: [], direction: 'out', hidden: [] };
  /** Set once the webview says it is listening, so we never post into the void. */
  private ready = false;
  private pendingAnalysis: Promise<void> | undefined;

  static show(context: vscode.ExtensionContext, anchorFsPath?: string): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(column);
      if (anchorFsPath) void GraphPanel.current.setAnchorFromFsPath(anchorFsPath);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'archlink.graph',
      'Project Relationships',
      column,
      {
        enableScripts: true,
        // Restricted to our bundle output; nothing else on disk is reachable.
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out')],
        retainContextWhenHidden: true,
      },
    );

    GraphPanel.current = new GraphPanel(panel, context, anchorFsPath);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    anchorFsPath?: string,
  ) {
    this.panel = panel;
    this.context = context;

    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: FromWebview) => void this.onMessage(m),
      null,
      this.disposables,
    );

    void this.analyzeAndSend(anchorFsPath);
  }

  // ---------------------------------------------------------------- messaging

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        // The analysis may have finished before the webview mounted.
        await this.pendingAnalysis;
        if (this.graph) this.send();
        break;

      case 'requery':
        this.state = { ...this.state, ...msg.state };
        this.send();
        break;

      case 'expand':
        this.state = { ...this.state, expanded: [...new Set([...this.state.expanded, msg.id])] };
        this.send();
        break;

      case 'collapse':
        // Nodes reachable only through this one disappear on their own, since
        // explore() walks exclusively through expanded nodes.
        this.state = {
          ...this.state,
          expanded: this.state.expanded.filter((id) => id !== msg.id),
        };
        this.send();
        break;

      case 'expandBranch': {
        if (!this.graph) break;
        const branch = branchFrom(
          this.graph,
          msg.id,
          this.state.direction,
          this.visibleCategories(),
          BRANCH_LIMIT,
        );
        this.state = {
          ...this.state,
          expanded: [...new Set([...this.state.expanded, ...branch])],
        };
        this.send();
        break;
      }

      case 'collapseAll':
        this.state = { ...this.state, expanded: [] };
        this.send();
        break;

      case 'setAnchor':
        // A new anchor starts a fresh exploration rather than inheriting the
        // previous one's opened branches, which would rarely make sense.
        this.state = { ...this.state, anchor: msg.id, expanded: [] };
        this.send();
        break;

      case 'openFile':
        await this.openFile(msg.id, msg.line, msg.character);
        break;

      case 'savePositions': {
        const all = this.context.workspaceState.get<Record<string, unknown>>(POSITIONS_KEY) ?? {};
        all[msg.anchor] = msg.positions;
        await this.context.workspaceState.update(POSITIONS_KEY, all);
        break;
      }

      case 'reanalyze':
        this.graph = undefined;
        this.post({ type: 'status', text: 'Re-analyzing workspace...' });
        await this.analyzeAndSend(undefined, this.state.anchor);
        break;
    }
  }

  // ---------------------------------------------------------------- analysis

  private async analyzeAndSend(anchorFsPath?: string, keepAnchor?: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: 'error', message: 'No folder is open, so there is nothing to analyze.' });
      return;
    }

    this.pendingAnalysis = (async () => {
      try {
        const started = Date.now();
        const graph = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'Analyzing project relationships',
          },
          async () => {
            // Yield so the progress indicator paints before the scan blocks.
            await new Promise((r) => setTimeout(r, 0));
            return analyze(folder.uri.fsPath);
          },
        );
        this.analysisMs = Date.now() - started;
        this.graph = graph;

        this.state.anchor =
          (keepAnchor && graph.nodes.has(keepAnchor) ? keepAnchor : undefined) ??
          this.pickAnchor(graph, anchorFsPath);

        if (this.ready) this.send();
      } catch (err) {
        const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
        this.post({ type: 'error', message });
      }
    })();

    await this.pendingAnalysis;
  }

  /** Prefer the file the user invoked us on, then the active editor, then a route. */
  private pickAnchor(graph: Graph, anchorFsPath?: string): string {
    const toId = (fsPath: string): string | undefined => {
      const id = path.relative(graph.root, fsPath).split(path.sep).join('/');
      return graph.nodes.has(id) ? id : undefined;
    };

    if (anchorFsPath) {
      const id = toId(anchorFsPath);
      if (id) return id;
    }
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
      const id = toId(active);
      if (id) return id;
    }
    // Fall back to the most-depended-upon route, which is the most useful
    // orientation point in an unfamiliar codebase.
    const routes = [...graph.nodes.values()].filter((n) => n.category === 'route');
    const pool = routes.length > 0 ? routes : [...graph.nodes.values()];
    let best = pool[0]?.id ?? '';
    let bestCount = -1;
    for (const n of pool) {
      const c = graph.dependents.get(n.id)?.size ?? 0;
      if (c > bestCount) { bestCount = c; best = n.id; }
    }
    return best;
  }

  private async setAnchorFromFsPath(fsPath: string): Promise<void> {
    if (!this.graph) return;
    const id = path.relative(this.graph.root, fsPath).split(path.sep).join('/');
    if (this.graph.nodes.has(id)) {
      this.state = { ...this.state, anchor: id, expanded: [] };
      this.send();
    }
  }

  private send(): void {
    const graph = this.graph;
    if (!graph) return;

    const explored = explore(graph, {
      anchor: this.state.anchor,
      expanded: new Set(this.state.expanded),
      direction: this.state.direction as Direction,
      categories: this.visibleCategories(),
      maxNodes: BRANCH_LIMIT,
    });

    const d = graph.diagnostics;
    const stats: GraphStats = {
      filesScanned: d.filesScanned,
      resolvedEdges: graph.edges.filter((e) => e.to !== null).length,
      unresolvedEdges: graph.edges.filter((e) => e.to === null && !e.unanalyzable).length,
      undecidable: d.unanalyzableImports,
      barrelChains: d.barrelResolved,
      isMonorepo: d.isMonorepo,
      monorepoReason: d.monorepoReason,
      analysisMs: this.analysisMs,
    };

    const saved = this.context.workspaceState.get<Record<string, Record<string, { x: number; y: number }>>>(
      POSITIONS_KEY,
    ) ?? {};

    const present = new Set<Category>([...graph.nodes.values()].map((n) => n.category));

    this.post({
      type: 'graph',
      graph: explored,
      state: this.state,
      stats,
      positions: saved[this.state.anchor] ?? {},
      availableCategories: [...present].sort(),
    });
  }

  /** Categories still switched on, or undefined when nothing is filtered out. */
  private visibleCategories(): Set<Category> | undefined {
    const hidden = new Set(this.state.hidden);
    if (hidden.size === 0 || !this.graph) return undefined;
    return new Set<Category>(
      [...this.graph.nodes.values()].map((n) => n.category).filter((c) => !hidden.has(c)),
    );
  }

  private async openFile(id: string, line?: number, character?: number): Promise<void> {
    if (!this.graph) return;
    const uri = vscode.Uri.file(path.join(this.graph.root, id));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
      });
      if (line !== undefined) {
        // Analyzer lines are 1-based; VS Code positions are 0-based.
        const pos = new vscode.Position(Math.max(0, line - 1), character ?? 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${id}`);
    }
  }

  // ---------------------------------------------------------------- html/CSP

  private html(): string {
    const w = this.panel.webview;
    const uri = (f: string) =>
      w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', f));

    // A fresh nonce per load; the only script allowed to run is our bundle.
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
        Math.floor(Math.random() * 62)
      ],
    ).join('');

    // style-src needs 'unsafe-inline' because React Flow positions nodes with
    // inline transform styles. Scripts stay nonce-locked and no remote origin
    // is permitted, so this does not allow script execution.
    const csp = [
      "default-src 'none'",
      `img-src ${w.cspSource} data:`,
      `font-src ${w.cspSource}`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('webview.css')}">
<title>Project Relationships</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    GraphPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
