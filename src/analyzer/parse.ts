import * as path from 'node:path';
import ts from 'typescript';

export interface ImportBinding {
  /** Name as exported by the target module; 'default' for default imports. */
  imported: string;
  /** Local alias in this file - what JSX would reference. */
  local: string;
  isNamespace?: boolean;
}

export interface ImportRef {
  /** For unanalyzable specifiers this is the raw source text of the argument. */
  specifier: string;
  kind: 'imports' | 'imports-type' | 'reexports' | 'dynamic-imports' | 'requires';
  at: { line: number; character: number };
  bindings: ImportBinding[];
  /**
   * The specifier is not a string literal, e.g. import(`./locale/${lang}`).
   * Statically undecidable rather than a resolution failure - the two must be
   * counted separately or the accuracy metric lies.
   */
  unanalyzable?: boolean;
}

export interface ReExport {
  /** Module specifier being re-exported from. */
  specifier: string;
  /** True for `export * from "./x"`. */
  star: boolean;
  /** For named re-exports: exported name plus the name in the source module. */
  names: Array<{ exported: string; imported: string }>;
}

export interface ParseResult {
  imports: ImportRef[];
  reExports: ReExport[];
  /** Names exported and defined in this file (not re-exported). */
  localExports: string[];
  directive?: 'use client' | 'use server';
  /** Local identifiers used as JSX element names - powers the `renders` badge. */
  jsxNames: Set<string>;
  callsCreateContext: boolean;
  definesComponent: boolean;
  definesHook: boolean;
  /** True when every export is type-only (interface/type/.d.ts). */
  typeOnlyModule: boolean;
  hasSyntaxError: boolean;
}

function scriptKind(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/** Leading 'use client' / 'use server' directive, if any. */
function readDirective(sf: ts.SourceFile): ParseResult['directive'] {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) break;
    const e = stmt.expression;
    if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) break;
    if (e.text === 'use client' || e.text === 'use server') return e.text;
  }
  return undefined;
}

/**
 * Root identifier of a JSX tag name: Foo -> Foo, Foo.Bar -> Foo.
 * `dotted` matters because a dotted tag (`<ns.Thing/>`) is never an intrinsic
 * HTML element, so the lowercase filter must not apply to it.
 */
function jsxRootName(tag: ts.JsxTagNameExpression): { name: string; dotted: boolean } | undefined {
  if (ts.isIdentifier(tag)) return { name: tag.text, dotted: false };
  if (ts.isPropertyAccessExpression(tag)) {
    let e: ts.Expression = tag;
    while (ts.isPropertyAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? { name: e.text, dotted: true } : undefined;
  }
  return undefined;
}

function bindingsOf(clause: ts.ImportClause | undefined): ImportBinding[] {
  const out: ImportBinding[] = [];
  if (!clause) return out;
  if (clause.name) out.push({ imported: 'default', local: clause.name.text });
  const nb = clause.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) {
    out.push({ imported: '*', local: nb.name.text, isNamespace: true });
  } else if (nb && ts.isNamedImports(nb)) {
    for (const el of nb.elements) {
      out.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
    }
  }
  return out;
}

/** Does this node contain JSX anywhere inside it? */
function containsJsx(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
  return found;
}

export function parseFile(file: string, text: string): ParseResult {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const diags = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;

  const res: ParseResult = {
    imports: [],
    reExports: [],
    localExports: [],
    directive: readDirective(sf),
    jsxNames: new Set(),
    callsCreateContext: false,
    definesComponent: false,
    definesHook: false,
    typeOnlyModule: false,
    hasSyntaxError: (diags?.length ?? 0) > 0,
  };

  const pos = (n: ts.Node) => {
    const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { line: lc.line + 1, character: lc.character };
  };

  const isExported = (n: ts.Node): boolean =>
    !!(ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export);

  let valueExports = 0;
  let typeExports = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      res.imports.push({
        specifier: node.moduleSpecifier.text,
        kind: node.importClause?.isTypeOnly ? 'imports-type' : 'imports',
        at: pos(node),
        bindings: bindingsOf(node.importClause),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const names: ReExport['names'] = [];
      let star = true;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        star = false;
        for (const el of node.exportClause.elements) {
          names.push({ exported: el.name.text, imported: (el.propertyName ?? el.name).text });
        }
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
        star = false;
        names.push({ exported: node.exportClause.name.text, imported: '*' });
      }
      res.reExports.push({ specifier, star, names });
      res.imports.push({
        specifier,
        kind: node.isTypeOnly ? 'imports-type' : 'reexports',
        at: pos(node),
        bindings: names.map((n) => ({ imported: n.imported, local: n.exported })),
      });
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamic || isRequire) && arg) {
        const literal = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg);
        res.imports.push({
          // Never drop a dynamic import: an undeclared edge is invisible, and
          // invisible is exactly how the other tools end up quietly wrong.
          specifier: literal ? (arg as ts.StringLiteralLike).text : arg.getText(sf),
          kind: isDynamic ? 'dynamic-imports' : 'requires',
          at: pos(node),
          bindings: [],
          unanalyzable: literal ? undefined : true,
        });
      }
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'createContext') {
        res.callsCreateContext = true;
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createContext') {
        res.callsCreateContext = true;
      }
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const n = jsxRootName(node.tagName);
      // A bare lowercase tag is an intrinsic HTML element, never an import.
      // A dotted tag always refers to a binding, whatever its case.
      if (n && (n.dotted || /^[A-Z]/.test(n.name))) res.jsxNames.add(n.name);
    }

    // Exports defined in this file.
    if (ts.isExportAssignment(node)) {
      res.localExports.push('default');
      valueExports++;
      if (containsJsx(node)) res.definesComponent = true;
    } else if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      if (isExported(node)) {
        res.localExports.push(node.name.text);
        typeExports++;
      }
    } else if (ts.isEnumDeclaration(node)) {
      // An enum emits runtime code, so it is a value export, not a type export.
      if (isExported(node)) {
        res.localExports.push(node.name.text);
        valueExports++;
      }
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      // export namespace Foo { ... }
      if (isExported(node)) {
        res.localExports.push(node.name.text);
        valueExports++;
      }
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (isExported(node)) {
        const isDefault = !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default);
        const name = node.name?.text ?? 'default';
        res.localExports.push(isDefault ? 'default' : name);
        valueExports++;
        if (/^use[A-Z]/.test(name)) res.definesHook = true;
        if ((isDefault || /^[A-Z]/.test(name)) && containsJsx(node)) res.definesComponent = true;
      }
    } else if (ts.isVariableStatement(node)) {
      if (isExported(node)) {
        for (const d of node.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          res.localExports.push(d.name.text);
          valueExports++;
          if (/^use[A-Z]/.test(d.name.text)) res.definesHook = true;
          if (/^[A-Z]/.test(d.name.text) && d.initializer && containsJsx(d.initializer)) {
            res.definesComponent = true;
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const el of node.exportClause.elements) {
        res.localExports.push(el.name.text);
        valueExports++;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  res.typeOnlyModule = file.endsWith('.d.ts') || (typeExports > 0 && valueExports === 0);
  res.localExports = [...new Set(res.localExports)];
  return res;
}
