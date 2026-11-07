/**
 * Barrel resolution.
 *
 * `import { Button } from '@/components'` resolves to `components/index.ts`.
 * Without following the re-export chain to `components/Button.tsx`, every graph
 * of a real project collapses into hub-and-spoke stars around index files and
 * looks broken. This module walks that chain using parse-only data.
 */

export interface ExportTable {
  /** Names defined in this file. */
  local: Set<string>;
  /** Exported name -> where it actually comes from. */
  named: Map<string, { from: string; imported: string }>;
  /** Node ids targeted by `export * from '...'`, in source order. */
  stars: string[];
  /** Names re-exported from an external package: `export { X } from 'pkg'`. */
  externalNames: Set<string>;
  /** True when the file has `export * from 'pkg'` for some external package. */
  hasExternalStar: boolean;
}

export interface BarrelHit {
  /** Node id of the file that actually defines the name. */
  target: string;
  /** Node id of the barrel we passed through, when we passed through one. */
  viaBarrel?: string;
  /**
   * The name is re-exported from an external package, so the chain correctly
   * ends at this file. A distinct outcome from "could not be traced" - one is
   * expected, the other means our export extraction has a gap.
   */
  external?: boolean;
}

const MAX_DEPTH = 12;

/**
 * Find the file that actually defines `name` as exported by `fileId`.
 * Returns null when the name cannot be traced, so the caller can fall back to
 * an edge pointing at the barrel itself - coarse but never wrong, and never
 * a dropped edge.
 */
export function resolveExport(
  fileId: string,
  name: string,
  tables: Map<string, ExportTable>,
): BarrelHit | null {
  const seen = new Set<string>();

  const walk = (id: string, want: string, depth: number, barrel?: string): BarrelHit | null => {
    if (depth > MAX_DEPTH) return null;
    const key = `${id}\0${want}`;
    if (seen.has(key)) return null; // cyclic re-exports must not hang
    seen.add(key);

    const table = tables.get(id);
    if (!table) return null; // outside the scanned set

    // A namespace re-export (`export * as ns from './m'`) terminates at './m'.
    if (want === '*') return { target: id, viaBarrel: barrel };

    if (table.local.has(want)) return { target: id, viaBarrel: barrel };

    const named = table.named.get(want);
    if (named) return walk(named.from, named.imported, depth + 1, barrel ?? id);

    // Explicitly re-exported from a package: the chain ends here, correctly.
    if (table.externalNames.has(want)) {
      return { target: id, viaBarrel: barrel, external: true };
    }

    // `export * from` does not forward a default export (ES semantics).
    if (want !== 'default') {
      for (const star of table.stars) {
        const hit = walk(star, want, depth + 1, barrel ?? id);
        if (hit) return hit;
      }
      // An external star re-export plausibly supplies the name, and we cannot
      // see inside node_modules to confirm. Stop here rather than report a gap.
      if (table.hasExternalStar) {
        return { target: id, viaBarrel: barrel, external: true };
      }
    }

    return null;
  };

  const hit = walk(fileId, name, 0);
  // Not a barrel hop if we never left the original file - but keep `external`,
  // which distinguishes "re-exported from a package" from "defined here".
  if (hit && hit.target === fileId) {
    return hit.external ? { target: fileId, external: true } : { target: fileId };
  }
  return hit;
}
