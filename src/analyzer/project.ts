import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

/** Pruned at the directory level — never walked, so node_modules costs nothing. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel',
  'dist', 'build', 'out', 'coverage', '.cache', '.yarn', '.pnpm-store',
  'storybook-static', '__snapshots__', '.idea', '.vscode-test',
]);

export interface Project {
  root: string;
  files: string[];
  options: ts.CompilerOptions;
  tsconfigPath?: string;
  isMonorepo: boolean;
  monorepoReason?: string;
  /** Absolute path of the Next.js app/ dir, if present. */
  appDir?: string;
  /** Absolute path of the Next.js pages/ dir, if present. */
  pagesDir?: string;
}

function walk(dir: string, out: string[], limit: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir (permissions, broken symlink) — skip, don't abort
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(full, out, limit);
    } else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
}

/**
 * Monorepo detection. We block rather than guess: a single tsconfig cannot
 * resolve aliases across packages, so a best-effort graph would be quietly wrong.
 */
function detectMonorepo(root: string): string | undefined {
  if (fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))) return 'pnpm-workspace.yaml';
  for (const f of ['turbo.json', 'lerna.json', 'nx.json', 'rush.json']) {
    if (fs.existsSync(path.join(root, f))) return f;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.workspaces) return 'package.json "workspaces"';
  } catch { /* no or invalid package.json — not a monorepo signal */ }
  return undefined;
}

function findNextDir(root: string, name: string): string | undefined {
  for (const base of [root, path.join(root, 'src')]) {
    const p = path.join(base, name);
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch { /* not present */ }
  }
  return undefined;
}

export function loadProject(root: string, fileLimit = 20000): Project {
  root = path.resolve(root);

  // tsconfig first, jsconfig as fallback — mirrors what bundlers do.
  let tsconfigPath: string | undefined;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = ts.findConfigFile(root, ts.sys.fileExists, name);
    // findConfigFile walks upward; only accept a config at or below root.
    if (p && path.resolve(p).startsWith(root)) { tsconfigPath = p; break; }
  }

  let options: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.Latest,
  };

  if (tsconfigPath) {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!read.error && read.config) {
      const parsed = ts.parseJsonConfigFileContent(
        read.config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath,
      );
      // Keep our permissive defaults where the project left a field unset.
      options = { ...options, ...parsed.options };
      if (options.allowJs === undefined) options.allowJs = true;
    }
  }

  const files: string[] = [];
  walk(root, files, fileLimit);

  const monorepoReason = detectMonorepo(root);

  return {
    root,
    files,
    options,
    tsconfigPath,
    isMonorepo: monorepoReason !== undefined,
    monorepoReason,
    appDir: findNextDir(root, 'app'),
    pagesDir: findNextDir(root, 'pages'),
  };
}

/** Workspace-relative POSIX id. Node identity is the path, so dupes can't happen. */
export function toId(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
