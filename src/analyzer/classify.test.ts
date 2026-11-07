import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './classify.ts';
import { parseFile } from './parse.ts';
import type { ParseResult } from './parse.ts';

const EMPTY: ParseResult = {
  imports: [], reExports: [], localExports: [], jsxNames: new Set(),
  callsCreateContext: false, definesComponent: false, definesHook: false,
  typeOnlyModule: false, hasSyntaxError: false,
};
const p = (over: Partial<ParseResult> = {}): ParseResult => ({ ...EMPTY, ...over });

const cat = (id: string, parse = EMPTY, dirs: { appDir?: string; pagesDir?: string } = {}) =>
  classify({ id, parse, ...dirs });

// ---------------------------------------------------------------- App Router

test('App Router page, layout, template and route handler', () => {
  const a = { appDir: 'src/app' };
  assert.equal(cat('src/app/page.tsx', EMPTY, a).category, 'route');
  assert.equal(cat('src/app/layout.tsx', EMPTY, a).category, 'layout');
  assert.equal(cat('src/app/template.tsx', EMPTY, a).category, 'layout');
  assert.equal(cat('src/app/api/users/route.ts', EMPTY, a).category, 'route-handler');
});

test('App Router special files', () => {
  const a = { appDir: 'app' };
  for (const n of ['loading', 'error', 'not-found', 'global-error', 'default', 'forbidden', 'unauthorized']) {
    assert.equal(cat(`app/${n}.tsx`, EMPTY, a).category, 'route-special', n);
  }
});

test('route groups are stripped from the URL path', () => {
  const r = cat('app/(marketing)/about/page.tsx', EMPTY, { appDir: 'app' });
  assert.equal(r.routePath, '/about');
});

test('parallel route slots are stripped', () => {
  const r = cat('app/dashboard/@modal/page.tsx', EMPTY, { appDir: 'app' });
  assert.equal(r.routePath, '/dashboard');
});

test('dynamic, catch-all and optional catch-all segments are preserved', () => {
  const a = { appDir: 'app' };
  assert.equal(cat('app/shop/[id]/page.tsx', EMPTY, a).routePath, '/shop/[id]');
  assert.equal(cat('app/docs/[...slug]/page.tsx', EMPTY, a).routePath, '/docs/[...slug]');
  assert.equal(cat('app/docs/[[...slug]]/page.tsx', EMPTY, a).routePath, '/docs/[[...slug]]');
});

test('the app root page maps to /', () => {
  assert.equal(cat('app/page.tsx', EMPTY, { appDir: 'app' }).routePath, '/');
});

// -------------------------------------------------------------- Pages Router

test('Pages Router pages, api routes and app shell', () => {
  const g = { pagesDir: 'pages' };
  assert.equal(cat('pages/index.tsx', EMPTY, g).category, 'route');
  assert.equal(cat('pages/index.tsx', EMPTY, g).routePath, '/');
  assert.equal(cat('pages/blog/[slug].tsx', EMPTY, g).routePath, '/blog/[slug]');
  assert.equal(cat('pages/api/users.ts', EMPTY, g).category, 'route-handler');
  assert.equal(cat('pages/_app.tsx', EMPTY, g).category, 'layout');
  assert.equal(cat('pages/_document.tsx', EMPTY, g).category, 'layout');
});

// --------------------------------------------------------------------- proxy

test('both proxy.ts and the deprecated middleware.ts are recognised', () => {
  // Next 16 renamed middleware -> proxy; real projects contain either.
  assert.equal(cat('proxy.ts').category, 'proxy');
  assert.equal(cat('middleware.ts').category, 'proxy');
  assert.equal(cat('src/proxy.ts').category, 'proxy');
  assert.equal(cat('src/middleware.ts').category, 'proxy');
});

test('a deeply nested file named proxy is not the Next.js proxy', () => {
  assert.notEqual(cat('src/lib/http/proxy.ts').category, 'proxy');
});

// ----------------------------------------------------------- React semantics

test('context wins over hook when a file does both', () => {
  // The standard pattern: createContext + Provider + use* consumer in one file.
  const r = cat('ctx.tsx', p({ callsCreateContext: true, definesHook: true, definesComponent: true }));
  assert.equal(r.category, 'context');
});

test('a hook file is classified as a hook', () => {
  assert.equal(cat('hooks/useUser.ts', p({ definesHook: true })).category, 'hook');
  // Name alone is enough, since not every hook is detected structurally.
  assert.equal(cat('hooks/useThing.ts').category, 'hook');
});

test('a component file is classified as a component', () => {
  assert.equal(cat('Card.tsx', p({ definesComponent: true })).category, 'component');
});

test('a pure re-export file is a barrel', () => {
  const parsed = parseFile('/x/index.ts', 'export * from "./a";\nexport { b } from "./b";\n');
  assert.equal(cat('components/index.ts', parsed).category, 'barrel');
});

test('an index file that defines its own exports is not a barrel', () => {
  const parsed = parseFile('/x/index.ts', 'export const a = 1;\nexport * from "./b";\n');
  assert.notEqual(cat('lib/index.ts', parsed).category, 'barrel');
});

test('a type-only module is classified as types', () => {
  assert.equal(cat('types/user.ts', p({ typeOnlyModule: true })).category, 'type');
  assert.equal(cat('global.d.ts', p({ typeOnlyModule: true })).category, 'type');
});

test('tests and configs are identified before anything else', () => {
  assert.equal(cat('Button.test.tsx', p({ definesComponent: true })).category, 'test');
  assert.equal(cat('Button.spec.ts').category, 'test');
  assert.equal(cat('__tests__/thing.ts').category, 'test');
  assert.equal(cat('next.config.js').category, 'config');
  assert.equal(cat('tailwind.config.ts').category, 'config');
  assert.equal(cat('instrumentation.ts').category, 'config');
});

test('a plain service module falls back to module', () => {
  assert.equal(cat('services/userService.ts').category, 'module');
  assert.equal(cat('lib/apiClient.ts').category, 'module');
});

test('a colocated component inside app/ is a component, not a route', () => {
  const r = cat('app/dashboard/UserCard.tsx', p({ definesComponent: true }), { appDir: 'app' });
  assert.equal(r.category, 'component');
});

test('router provenance is reported for framework files', () => {
  assert.equal(cat('app/page.tsx', EMPTY, { appDir: 'app' }).router, 'app');
  assert.equal(cat('pages/about.tsx', EMPTY, { pagesDir: 'pages' }).router, 'pages');
  assert.equal(cat('lib/util.ts').router, undefined);
});
