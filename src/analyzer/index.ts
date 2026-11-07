import * as fs from 'node:fs';
import type { Edge, Graph, GraphNode, Diagnostics } from './types.ts';
import { loadProject, toId } from './project.ts';
import { parseFile, type ParseResult } from './parse.ts';
import { Resolver } from './resolve.ts';
import { resolveExport, type ExportTable } from './barrels.ts';
import { classify } from './classify.ts';

export interface AnalyzeOptions {
  fileLimit?: number;
  /** Called periodically so a host can report progress and stay responsive. */
  onProgress?: (done: number, total: number) => void;
}

export function analyze(root: string, opts: AnalyzeOptions = {}): Graph {
  const t0 = performance.now();
  const project = loadProject(root, opts.fileLimit);
  const tLoad = performance.now();

  const resolver = new Resolver(project.root, project.options);
  const appDir = project.appDir ? toId(project.root, project.appDir) : undefined;
  const pagesDir = project.pagesDir ? toId(project.root, project.pagesDir) : undefined;

  const nodes = new Map<string, GraphNode>();
  const parses = new Map<string, ParseResult>();
  const diagnostics: Diagnostics = {
    filesScanned: 0,
    filesSkipped: 0,
    syntaxErrors: [],
    unresolved: new Map(),
    barrelFallbacks: 0,
    barrelResolved: 0,
    barrelExternal: 0,
    unanalyzableImports: 0,
    assetImports: 0,
    isMonorepo: project.isMonorepo,
    monorepoReason: project.monorepoReason,
    tsconfigPath: project.tsconfigPath,
    timings: {},
  };

  // ---- Pass 1: parse every file, build nodes.
  for (let i = 0; i < project.files.length; i++) {
    const abs = project.files[i];
    const id = toId(project.root, abs);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      diagnostics.filesSkipped++;
      continue;
    }

    const parse = parseFile(abs, text);
    parses.set(id, parse);
    diagnostics.filesScanned++;
    if (parse.hasSyntaxError) diagnostics.syntaxErrors.push(id);

    const { category, router, routePath } = classify({ id, parse, appDir, pagesDir });
    nodes.set(id, {
      id,
      label: id.split('/').pop() ?? id,
      category,
      router,
      routePath,
      directive: parse.directive,
      exports: parse.localExports,
      hasSyntaxError: parse.hasSyntaxError || undefined,
    });

    if (opts.onProgress && i % 200 === 0) opts.onProgress(i, project.files.length);
  }
  const tParse = performance.now();

  // ---- Pass 2: export tables, so barrel chains can be walked in pass 3.
  const tables = new Map<string, ExportTable>();
  for (const [id, parse] of parses) {
    const named = new Map<string, { from: string; imported: string }>();
    const stars: string[] = [];
    const reExportedNames = new Set<string>();
    const externalNames = new Set<string>();
    let hasExternalStar = false;

    for (const re of parse.reExports) {
      const absTarget = resolver.resolve(re.specifier, absOf(project.root, id));
      if (!absTarget) {
        // Re-exported from outside the graph. For a package this is expected
        // and the chain legitimately ends here; a broken relative path is
        // still reported as an unresolved edge in pass 3.
        if (Resolver.isExternal(re.specifier)) {
          if (re.star) hasExternalStar = true;
          for (const n of re.names) {
            externalNames.add(n.exported);
            reExportedNames.add(n.exported);
          }
        }
        continue;
      }
      const targetId = toId(project.root, absTarget);
      if (re.star) {
        stars.push(targetId);
      } else {
        for (const n of re.names) {
          named.set(n.exported, { from: targetId, imported: n.imported });
          reExportedNames.add(n.exported);
        }
      }
    }

    // A re-exported name is not defined locally, even though `export { x } from`
    // also lands in localExports during parsing.
    const local = new Set(parse.localExports.filter((n) => !reExportedNames.has(n)));
    tables.set(id, { local, named, stars, externalNames, hasExternalStar });
  }
  const tTables = performance.now();

  // ---- Pass 3: edges, with barrel chains followed and failures recorded.
  const edges: Edge[] = [];
  const dependents = new Map<string, Set<string>>();

  const addDependent = (target: string, source: string): void => {
    let set = dependents.get(target);
    if (!set) dependents.set(target, (set = new Set()));
    set.add(source);
  };

  for (const [id, parse] of parses) {
    const abs = absOf(project.root, id);

    for (const imp of parse.imports) {
      // Undecidable specifier, e.g. import(`./locale/${lang}`). Emit a visible
      // marker edge, but keep it out of the unresolved count: this is a limit
      // of static analysis, not a failure of our resolver.
      if (imp.unanalyzable) {
        diagnostics.unanalyzableImports++;
        edges.push({
          from: id, to: null, specifier: imp.specifier,
          kind: imp.kind, confidence: 'medium', at: imp.at, unanalyzable: true,
        });
        continue;
      }

      // Stylesheets and other loader-handled assets are not modules. Counted,
      // not charged against the resolution rate.
      if (Resolver.isAsset(imp.specifier)) {
        diagnostics.assetImports++;
        continue;
      }

      // External packages are not graph nodes; count them as resolved-by-design.
      if (Resolver.isExternal(imp.specifier) && !resolver.resolve(imp.specifier, abs)) {
        continue;
      }

      const absTarget = resolver.resolve(imp.specifier, abs);
      if (!absTarget) {
        diagnostics.unresolved.set(
          imp.specifier,
          (diagnostics.unresolved.get(imp.specifier) ?? 0) + 1,
        );
        edges.push({
          from: id, to: null, specifier: imp.specifier,
          kind: imp.kind, confidence: 'high', at: imp.at,
        });
        continue;
      }

      const directId = toId(project.root, absTarget);

      // Follow named bindings through barrels to the defining file.
      // Namespace and side-effect imports have no name to trace, so they
      // legitimately point at the module itself.
      const traceable = imp.bindings.filter((b) => !b.isNamespace && b.imported !== '*');
      if (traceable.length === 0) {
        edges.push({
          from: id, to: directId, specifier: imp.specifier,
          kind: imp.kind, confidence: 'high', at: imp.at,
        });
        addDependent(directId, id);
        continue;
      }

      // One edge per distinct resolved target: `import {A, B} from './pair'`
      // where A and B come from different files yields two honest edges.
      const byTarget = new Map<string, { viaBarrel?: string; locals: string[] }>();
      for (const b of traceable) {
        const hit = resolveExport(directId, b.imported, tables);
        if (hit?.external) diagnostics.barrelExternal++;
        else if (hit && hit.target !== directId) diagnostics.barrelResolved++;
        else if (!hit && tables.get(directId)) diagnostics.barrelFallbacks++;

        const target = hit?.target ?? directId;
        const entry = byTarget.get(target) ?? { viaBarrel: hit?.viaBarrel, locals: [] };
        entry.locals.push(b.local);
        byTarget.set(target, entry);
      }

      for (const [target, entry] of byTarget) {
        const renders = entry.locals.some((l) => parse.jsxNames.has(l));
        const badges: Edge['badges'] = {};
        if (renders) badges.renders = true;
        if (entry.viaBarrel) badges.viaBarrel = entry.viaBarrel;

        edges.push({
          from: id,
          to: target,
          specifier: imp.specifier,
          kind: imp.kind,
          // Reached through a barrel chain: correct by construction, but one
          // inference step removed from the literal source text.
          confidence: entry.viaBarrel ? 'medium' : 'high',
          at: imp.at,
          badges: Object.keys(badges).length ? badges : undefined,
        });
        addDependent(target, id);
      }
    }
  }
  const tEdges = performance.now();

  diagnostics.timings = {
    discover: Math.round(tLoad - t0),
    parse: Math.round(tParse - tLoad),
    exportTables: Math.round(tTables - tParse),
    edges: Math.round(tEdges - tTables),
    total: Math.round(tEdges - t0),
  };

  return { root: project.root, nodes, edges, dependents, diagnostics };
}

function absOf(root: string, id: string): string {
  return root + '/' + id;
}
