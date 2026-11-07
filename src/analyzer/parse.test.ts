import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from './parse.ts';

const SRC = `'use client';
import React from 'react';
import UserCard from '@/components/UserCard';
import { Button, Input as Field } from '@/components';
import type { User } from '@/types/user';
import * as utils from './utils';
import './styles.css';
export { default as Card } from './Card';
export * from './shared';
export * as ns from './ns';
const Lazy = () => import('@/components/Heavy');
const legacy = require('./legacy');
export const useUser = () => null;
export function Panel(){ return <div><Button/><Field/><utils.Thing/></div>; }
export default function Page(){ return <UserCard/>; }
export interface Props { a: number }
`;

const r = parseFile('/x/app/page.tsx', SRC);
const find = (spec: string) => r.imports.filter((i) => i.specifier === spec);

test('reads the use client directive', () => {
  assert.equal(r.directive, 'use client');
});

test('parses a valid file without syntax errors', () => {
  assert.equal(r.hasSyntaxError, false);
});

test('separates type-only imports from value imports', () => {
  assert.equal(find('@/types/user')[0].kind, 'imports-type');
  assert.equal(find('@/components/UserCard')[0].kind, 'imports');
});

test('captures named import bindings with aliases', () => {
  const b = find('@/components')[0].bindings;
  assert.deepEqual(
    b.map((x) => `${x.imported}->${x.local}`).sort(),
    ['Button->Button', 'Input->Field'],
  );
});

test('captures default and namespace imports', () => {
  assert.deepEqual(find('@/components/UserCard')[0].bindings, [
    { imported: 'default', local: 'UserCard' },
  ]);
  const ns = find('./utils')[0].bindings[0];
  assert.equal(ns.isNamespace, true);
  assert.equal(ns.local, 'utils');
});

test('records side-effect imports as edges with no bindings', () => {
  const css = find('./styles.css')[0];
  assert.equal(css.kind, 'imports');
  assert.deepEqual(css.bindings, []);
});

test('detects dynamic import() and require()', () => {
  assert.equal(find('@/components/Heavy')[0].kind, 'dynamic-imports');
  assert.equal(find('./legacy')[0].kind, 'requires');
});

test('records re-exports including star and namespace forms', () => {
  const bySpec = Object.fromEntries(r.reExports.map((e) => [e.specifier, e]));
  assert.equal(bySpec['./shared'].star, true);
  assert.deepEqual(bySpec['./Card'].names, [{ exported: 'Card', imported: 'default' }]);
  assert.deepEqual(bySpec['./ns'].names, [{ exported: 'ns', imported: '*' }]);
});

test('collects local exports', () => {
  for (const name of ['useUser', 'Panel', 'default', 'Props']) {
    assert.ok(r.localExports.includes(name), `missing export ${name}`);
  }
});

test('collects JSX element names, excluding intrinsic tags', () => {
  assert.deepEqual([...r.jsxNames].sort(), ['Button', 'Field', 'UserCard', 'utils']);
  assert.ok(!r.jsxNames.has('div'));
});

test('classifies component and hook definitions', () => {
  assert.equal(r.definesComponent, true);
  assert.equal(r.definesHook, true);
});

test('a type-only module is flagged as such', () => {
  const t = parseFile('/x/types/user.ts', 'export interface User { id: string }\nexport type Id = string;\n');
  assert.equal(t.typeOnlyModule, true);
  const v = parseFile('/x/lib/a.ts', 'export const a = 1;\nexport type B = string;\n');
  assert.equal(v.typeOnlyModule, false);
});

test('detects createContext calls', () => {
  const c = parseFile('/x/ctx.tsx', "import {createContext} from 'react';\nexport const C = createContext(null);\n");
  assert.equal(c.callsCreateContext, true);
  const c2 = parseFile('/x/ctx2.tsx', "import React from 'react';\nexport const C = React.createContext(null);\n");
  assert.equal(c2.callsCreateContext, true);
});

test('imports after a template literal are still found (preProcessFile bug)', () => {
  // ts.preProcessFile misses these; the AST walk must not.
  const p = parseFile('/x/a.ts', 'const s = `hi ${1}`;\nimport b from "./b";\n');
  assert.equal(p.imports.length, 1);
  assert.equal(p.imports[0].specifier, './b');
});

test('specifiers inside comments and strings are ignored', () => {
  const p = parseFile('/x/a.ts', '// import x from "./fake";\nconst s = \'import y from "./nope"\';\n');
  assert.deepEqual(p.imports, []);
});

test('a syntax error is flagged but parsing still yields imports', () => {
  const bad = parseFile('/x/bad.ts', 'import a from "./a";\nfunction ( { oops\n');
  assert.equal(bad.hasSyntaxError, true);
  assert.equal(bad.imports[0].specifier, './a');
});

test('import positions are 1-based lines for click-to-navigate', () => {
  assert.equal(find('react')[0].at.line, 2);
});

test('export enum and export namespace are collected as value exports', () => {
  // Regression: cal.com's `export enum OutOfOfficeTab` was invisible, which
  // made imports of it untraceable through the export table.
  const e = parseFile('/x/types.ts', 'export enum TimeZoneEnum { UTC = "UTC" }\n');
  assert.ok(e.localExports.includes('TimeZoneEnum'));
  assert.equal(e.typeOnlyModule, false, 'an enum emits runtime code');

  const n = parseFile('/x/ns.ts', 'export namespace Foo { export const a = 1; }\n');
  assert.ok(n.localExports.includes('Foo'));
});
