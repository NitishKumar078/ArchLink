<p align="center">
  <img src="images/banner.png" alt="Archlink" width="600" />
</p>

# Archlink

A VS Code extension that shows how the files in a React or Next.js
project actually connect — routes to components, components to hooks, hooks to
services — as an interactive, draggable graph.

**Status: working interactive graph.** The analyzer gate passed on four
production codebases, the React Flow panel renders, and the whole thing is
verified running in Antigravity IDE 1.107.0.

---

## Phase 0: the gate

Phase 0 exists to answer one question cheaply, before any UI work:

> Does accurate static analysis of a real React/Next.js project actually work,
> or does it fall apart on aliases, barrel files and framework conventions the
> way the existing tools do?

The metric is the **unresolved-edge rate**: imports we failed to resolve, as a
share of all module edges. The pass/fail thresholds were fixed *before* running
anything: `< 2%` green, `2–10%` investigate, `> 10%` stop.

### Results

| Target | Files | Edges | Unresolved | Rate | Verdict | Barrel chains | Untraced |
|---|---:|---:|---:|---:|:---:|---:|---:|
| vercel/commerce | 66 | 120 | 0 | **0.00%** | GREEN | 0 | 0 |
| dubinc/dub `apps/web` | 1,550 | 4,831 | 0 | **0.00%** | GREEN | 391 | 0 |
| calcom/cal.com `apps/web` | 994 | 1,542 | 0 | **0.00%** | GREEN | 64 | 0 |
| shadcn-ui/ui `apps/v4` | 3,682 | 8,996 | 1 | **0.01%** | GREEN | 0 | 0 |
| calcom/cal.com root (monorepo) | 5,071 | 6,143 | 9 | **0.15%** | GREEN | 330 | 13 |

11,363 files and 21,632 edges across four production codebases; 10 unresolved
imports in total. Reproduce with `npm run gate` after `scripts/clone-targets.sh`.

The `fixture (planted faults)` row reports STOP by design — the fixture contains
a deliberately broken import so we can prove the gate can fail.

### What the numbers mean

- **Barrel chains** — named imports traced *past* an `index.ts` to the file that
  actually defines the symbol. Verified against ground truth: in dub,
  `import { redis } from "@/lib/upstash"` correctly resolves to
  `lib/upstash/redis.ts`, not to the barrel. Without this, every barrel-using
  project renders as hub-and-spoke stars around index files.
- **Untraced** — a name that exists nowhere we can see. This is the honesty
  counter, and chasing it found a real parser gap: `export enum` was invisible,
  which made 4 cal.com imports untraceable. Now 0 on every single-app target.
- The monorepo root row keeps 13 untraced, which is expected and declared out
  of scope: cross-package resolution needs per-package configs.

### Performance (measured, not projected)

| Target | Files | Total | Per file | RSS |
|---|---:|---:|---:|---:|
| shadcn-ui `apps/v4` | 3,682 | 4,870 ms | 1.32 ms | 320 MB |
| dub `apps/web` | 1,550 | ~1,900 ms | ~1.2 ms | — |

Parsing dominates (~56%), resolution is next (~39%). Fast enough to index a
large app in seconds with no native dependencies. The 320 MB peak is the known
issue to address next (parse results are retained for all files through edge
building) — see Known limitations.

---

## Design rules

These are load-bearing, not style preferences.

1. **Uncertain analysis only ever decorates certain analysis.** A heuristic
   never generates structure. `renders` is a *badge on an import edge*, not its
   own edge kind — if the JSX heuristic is wrong you still see a correct import
   edge. Every competitor inverted this, which is why their graphs go wrong.
2. **Never drop an edge.** An invisible edge is indistinguishable from "no
   relationship", which is how a tool ends up quietly lying. Unresolvable
   imports are emitted with `to: null` and counted.
3. **Separate "undecidable" from "failed".** `import(\`./locale/${lang}\`)` is
   statically undecidable; a broken relative path is a failure. Conflating them
   makes the accuracy metric meaningless in both directions. Assets (`.css`,
   images, JSON) are a third category — not modules, not failures.
4. **Block rather than guess.** Monorepos are detected and declared
   unsupported, because a silently wrong graph is worse than no graph.

## Architecture

```
project.ts    discover files (pruning node_modules/.next/dist), parse tsconfig
parse.ts      parse-only AST -> imports, re-exports, exports, JSX names, directives
resolve.ts    ts.resolveModuleName + caches (aliases/extensions/index for free)
barrels.ts    walk re-export chains to the real defining file
classify.ts   React + Next.js category rules (App Router, Pages Router, proxy)
index.ts      3-pass orchestrator -> Graph { nodes, edges, dependents, diagnostics }
probe.ts      the Phase 0 gate report
```

Three passes, because barrel resolution needs every file's export table before
any edge can be traced.

## Key technical decisions

| Decision | Why |
|---|---|
| **`typescript` pinned to `5.9.3`** | `typescript@7.x` is the Go port and **does not ship the JS compiler API**; it is expected in 7.1. Do not bump this without verifying `ts.createSourceFile` and `ts.resolveModuleName` still exist. |
| Parse-only, no `ts.createProgram` | A full type checker costs 10–100× for marginal gain. Measured 1.32 ms/file without one. |
| AST walk, not `ts.preProcessFile` | `preProcessFile` misses imports after template literals ([#30878](https://github.com/Microsoft/TypeScript/issues/30878), [#51072](https://github.com/Microsoft/TypeScript/issues/51072)) and `import type` ([#37338](https://github.com/microsoft/TypeScript/issues/37338)). Both are covered by tests. |
| `ts.resolveModuleName` over a custom resolver | tsconfig `paths`, `baseUrl`, extension and index resolution come from TypeScript itself and cannot drift from bundler behaviour. |
| No native parser (oxc/SWC) | Faster, but ships per-platform binaries. The measured JS speed makes it unnecessary. |
| Pure JS/TS, no MS-only APIs | Required for Cursor and Antigravity (see below). |

## Editor compatibility (Cursor / Antigravity / VS Code)

Non-negotiable constraints, locked in before the UI exists:

- `engines.vscode: ^1.84.0` — Cursor bundles VS Code **1.105.1**; Antigravity IDE
  reports **1.107.0** (read from its `product.json`). Every API this needs
  shipped in 1.49, so the floor sits far below both. Cursor is the real
  ceiling, and a higher floor makes it silently install an older version.
- **No proposed APIs** (hard-gated in forks). **No `extensionDependencies`** on
  Microsoft extensions. **Never branch on `env.appName`**.
- Publish to **Open VSX** (`ovsx`) as well as the MS Marketplace — forks cannot
  use the MS Marketplace. Needs a claimed namespace and a license field.
- Bundling our own TypeScript (rather than piggybacking on VS Code's built-in
  TS extension) is what makes this portable at all.

## Source constraint: strip-only TypeScript

Source runs directly under `node --test` / `node src/probe.ts` with no build
step, using Node's type-stripping. That forbids any TS syntax requiring
transformation:

- no constructor parameter properties (`constructor(private x: T)`)
- no `enum`, no `namespace`, no decorators in *our* source

(We still *parse* those constructs in analyzed projects — see the `export enum`
regression test.)

## Known limitations

| Limitation | Status |
|---|---|
| Monorepos | Detected and blocked. Not supported. |
| No file watcher | Use **Re-analyze** after changing files. |
| 320 MB peak RSS on a 3.7k-file project | Needs fixing before shipping: drop parse results after the export tables are built. |
| Conditional / HOC-wrapped rendering | Statically undecidable. Will never be supported; `renders` is best-effort and badged. |
| Transitive client/server boundary | Only the direct `'use client'` / `'use server'` directive is read. |
| `next.config` rewrites, `pageExtensions` | Not read. |
| Context provider/consumer pairing | `createContext` is detected; consumers are not paired. |

## Commands

```bash
npm test                              # 31 unit tests
npm run probe -- <project-root>       # full report for one project
npm run probe -- <root> --json        # machine-readable
npm run gate                          # the whole table
bash scripts/clone-targets.sh         # fetch the real-world targets
```

## Next: Phase 1

Extension skeleton — command, webview with strict CSP, React Flow
(`@xyflow/react` 12, MIT) with draggable nodes, `@dagrejs/dagre` 3.1.3 layout
(MIT; `elkjs` rejected as EPL/GPL). Analyzer stays as-is; the webview receives
only a focus-scoped subgraph, never the whole project, because React Flow
degrades badly past a few hundred DOM nodes.

---

## Running it locally (no packaging)

Verified working in **Antigravity IDE 1.107.0** on 2026-10-29. Antigravity hides
`--extensionDevelopmentPath` from `--help`, but the flag works.

```bash
npm install
npm run build          # esbuild -> out/extension.cjs (~0.5s). Required: the
                       # extension host runs CommonJS JS, not .ts
```

Then either press **F5** in the editor (`.vscode/launch.json` is set up), or
launch the dev host from a terminal:

```bash
"$LOCALAPPDATA/Programs/Antigravity IDE/bin/antigravity-ide.cmd" \
  --extensionDevelopmentPath="$PWD" --new-window /path/to/your/react-project
```

In the new window: **Ctrl+Shift+P → "Archlink: Show Project Relationships"**,
or right-click a file in the explorer. Activation is lazy, so nothing runs
until you invoke the command.

Iterate with `npm run watch`, then **Ctrl+R** in the dev-host window to reload.

### Verifying host compatibility after an editor upgrade

```bash
npm run smoke:host                                  # Antigravity
powershell -File scripts/smoke-host.ps1 -Editor cursor
powershell -File scripts/smoke-host.ps1 -Editor code
```

It flips activation to `onStartupFinished`, launches the dev host, waits for the
analyzer to report, and always restores lazy activation. Verified result:

```
Antigravity IDE  API 1.107.0
ANALYSIS  files=1550  edges=4831  barrels=391  ms=2163
```

Identical to the CLI numbers for the same project, which confirms the bundled
TypeScript compiler works inside the Electron extension host.

### Editor CLI paths (Windows)

| Editor | CLI | Gallery |
|---|---|---|
| Antigravity IDE 1.107.0 | `%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd` | `open-vsx.org` (confirmed in `product.json`) |
| Cursor 1.105.1 | `%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd` | Open VSX via proxy |
| VS Code | `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd` | MS Marketplace |

Antigravity's base (1.107.0) is *newer* than Cursor's (1.105.1), so Cursor sets
the real API ceiling. `engines.vscode: ^1.84.0` clears both.

---

## The graph panel

**Ctrl+Shift+P → "Show Project Relationships"**, or right-click a file in the
explorer → *Show Relationships for This File*.

The panel opens on one file and **grows only where you click**. There is no
depth slider: a global depth either shows too little or explodes (depth 2 in
both directions on dub hit a 200-node cap and rendered as an unreadable
vertical wall). Expanding per node keeps every intermediate state readable and
only costs what is actually on screen.

Start: the anchor plus its direct neighbours. Every node carries a **`+N`**
badge saying how much it hides. Click it to open one level; the node flips to
**`−`** and can be collapsed again.

**Expansion is additive.** Nodes already on screen keep their exact positions,
so opening a branch never rearranges what you are looking at - it only grows,
and the view pans (at your current zoom) to follow what you clicked.

**Shared dependencies connect to every visible parent.** If three siblings all
import the same module, you see three edges, not one - that a module is shared
is usually the most useful thing the graph can tell you. Back-edges between
visible nodes are drawn too, so cycles are visible.

| Control | What it does |
|---|---|
| `+N` on a node | Expand one level. **Shift-click** expands the whole branch below it. |
| `−` on a node | Collapse it; anything reachable only through it disappears. |
| `Uses →` / `← Used by` / `↔ Both` | Dependencies, dependents, or both. "Used by" is the impact-analysis view. |
| Expand all / Collapse all | The whole tree below the anchor, or back to the start. |
| search box | Dims non-matching nodes rather than removing them, so the shape stays intact. |
| category chips | Toggle whole categories out of the graph. |
| Re-layout | Discards dragged positions and re-runs dagre from scratch. |
| click node | Opens the file. |
| double-click node | Re-centres the graph on it (starts a fresh exploration). |
| click edge | Opens the importing file **at the import line**. |
| drag node | Moves it; the position is saved per anchor in `workspaceState`. |

### Reading the graph

- **Colour** is the primary channel, **icon** the secondary. Shape is used only
  where it earns its keep: routes get a route-shaped node, hooks and contexts a
  stadium, barrels a double border, types/config/tests a dashed one.
- A **thicker blue edge labelled `renders`** means the import is also used as a
  JSX element. This is a *badge on the import edge*, never its own edge type —
  if the heuristic misses, you still see a correct import edge.
- **`via barrel`** marks an edge whose target was traced through a re-export
  chain to the file that really defines the symbol.
- A **dashed red node** is an unresolved or undecidable import, kept visible
  rather than dropped.
- `C` / `S` badges mark `'use client'` / `'use server'`.
- The status bar always reports unresolved and undecidable counts, and says so
  when the 200-node cap truncated the view.

### Previewing the UI without the editor

```bash
npm run preview -- targets/dub/apps/web --depth 2 --dir out   # writes out/preview.html
node scripts/preview-server.mjs                                # serves it on :5174
```

Replays the exact `graph` message the extension posts, against a real analyzed
project, so what renders in the browser is what renders in the panel. This is
how the context-vs-hook classification bug was spotted. Dev-only, never shipped.
