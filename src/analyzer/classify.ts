import * as path from 'node:path';
import type { Category } from './types.ts';
import type { ParseResult } from './parse.ts';

/** App Router special files that are not pages, layouts or handlers. */
const ROUTE_SPECIAL = new Set([
  'loading', 'error', 'global-error', 'not-found', 'default', 'forbidden', 'unauthorized',
]);

const CONFIG_BASENAMES = new Set([
  'instrumentation', 'instrumentation-client', 'mdx-components',
  'next.config', 'tailwind.config', 'postcss.config', 'eslint.config',
  'vite.config', 'jest.config', 'vitest.config', 'playwright.config', 'babel.config',
]);

export interface ClassifyInput {
  /** Workspace-relative POSIX id. */
  id: string;
  parse: ParseResult;
  /** Workspace-relative POSIX path of the Next.js app dir, if any. */
  appDir?: string;
  /** Workspace-relative POSIX path of the Next.js pages dir, if any. */
  pagesDir?: string;
}

export interface Classification {
  category: Category;
  router?: 'app' | 'pages';
  routePath?: string;
}

/** Strip the extension, including the `.d` of `.d.ts`. */
function stem(id: string): string {
  const base = path.posix.basename(id);
  const noExt = base.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '');
  return noExt.replace(/\.d$/, '');
}

function isUnder(id: string, dir: string | undefined): boolean {
  return !!dir && (id === dir || id.startsWith(dir + '/'));
}

/**
 * Derive the URL path of an App Router route file.
 * Drops route groups `(marketing)`, parallel slots `@modal` and intercepting
 * prefixes, and keeps dynamic segments verbatim: `/shop/[id]`, `/docs/[...slug]`.
 */
function appRoutePath(id: string, appDir: string): string {
  const rel = id.slice(appDir.length).replace(/^\//, '');
  const segments = rel.split('/').slice(0, -1); // drop the filename
  const kept: string[] = [];
  for (const seg of segments) {
    if (/^\(.*\)$/.test(seg)) continue;       // route group, or intercepting (.)(..)( ...)
    if (seg.startsWith('@')) continue;        // parallel route slot
    kept.push(seg);
  }
  return '/' + kept.join('/');
}

/** Pages Router: `pages/blog/[slug].tsx` -> `/blog/[slug]`, index -> parent. */
function pagesRoutePath(id: string, pagesDir: string): string {
  let rel = id.slice(pagesDir.length).replace(/^\//, '');
  rel = rel.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  if (rel === 'index') return '/';
  rel = rel.replace(/\/index$/, '');
  return '/' + rel;
}

export function classify(input: ClassifyInput): Classification {
  const { id, parse, appDir, pagesDir } = input;
  const s = stem(id);
  const dirSegments = path.posix.dirname(id).split('/');

  // --- Tests and configs win outright: they are never application structure.
  if (/\.(test|spec)$/.test(s) || dirSegments.includes('__tests__')) {
    return { category: 'test' };
  }
  if (CONFIG_BASENAMES.has(s) || /\.config$/.test(s)) {
    return { category: 'config' };
  }

  // --- Next.js proxy: renamed from `middleware` in Next 16. Support both.
  // Must sit at the project root or in src/, beside app/ or pages/.
  const depth = id.split('/').length;
  if ((s === 'proxy' || s === 'middleware') && depth <= 2) {
    return { category: 'proxy' };
  }

  // --- App Router conventions.
  if (isUnder(id, appDir) && appDir) {
    if (s === 'page') return { category: 'route', router: 'app', routePath: appRoutePath(id, appDir) };
    if (s === 'route') return { category: 'route-handler', router: 'app', routePath: appRoutePath(id, appDir) };
    if (s === 'layout' || s === 'template') return { category: 'layout', router: 'app', routePath: appRoutePath(id, appDir) };
    if (ROUTE_SPECIAL.has(s)) return { category: 'route-special', router: 'app', routePath: appRoutePath(id, appDir) };
    // Any other file inside app/ is a colocated module, classified below.
  }

  // --- Pages Router conventions.
  if (isUnder(id, pagesDir) && pagesDir) {
    const rel = id.slice(pagesDir.length).replace(/^\//, '');
    if (rel.startsWith('api/')) {
      return { category: 'route-handler', router: 'pages', routePath: pagesRoutePath(id, pagesDir) };
    }
    if (s === '_app' || s === '_document') return { category: 'layout', router: 'pages' };
    if (s === '_error' || s === '404' || s === '500') return { category: 'route-special', router: 'pages' };
    return { category: 'route', router: 'pages', routePath: pagesRoutePath(id, pagesDir) };
  }

  // --- A pure barrel: re-exports only, defines nothing of its own.
  // Called out explicitly because barrel chains are what this tool exists to
  // get right, so the user should be able to see them in the graph.
  if (parse.reExports.length > 0 && parse.localExports.length === 0) {
    return { category: 'barrel' };
  }

  // --- Framework-agnostic React categories, most specific first.
  if (parse.typeOnlyModule) return { category: 'type' };
  // Context wins over hook: the standard pattern is one file exporting
  // createContext, a Provider and a use* consumer hook, and "context" is the
  // role that describes it. Checking hook first mislabels every such file.
  if (parse.callsCreateContext) return { category: 'context' };
  if (parse.definesHook || /^use[A-Z]/.test(s)) return { category: 'hook' };
  if (parse.definesComponent) return { category: 'component' };
  return { category: 'module' };
}
