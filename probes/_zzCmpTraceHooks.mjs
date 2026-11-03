// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCmpTraceHooks — module hooks that turn every comparison in src/ into a traced call, so
// _zzScaleCmpTrace can name the FIRST comparison whose outcome differs between two exactly related
// scales. Registered by that probe; not for use elsewhere.
//
// `a < b` becomes `globalThis.__C("file:line", a, b, op)` for < > <= >= == != === !==. Both operands are
// evaluated exactly as before, so nothing but the recording changes.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

const OPS = new Map([
  [ts.SyntaxKind.LessThanToken, 0],
  [ts.SyntaxKind.GreaterThanToken, 1],
  [ts.SyntaxKind.LessThanEqualsToken, 2],
  [ts.SyntaxKind.GreaterThanEqualsToken, 3],
  [ts.SyntaxKind.EqualsEqualsToken, 4],
  [ts.SyntaxKind.ExclamationEqualsToken, 5],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 6],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 7],
]);

function instrument(code, name) {
  const sf = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const f = ts.factory;
  // Line numbers come from the ORIGINAL tree, resolved before the transform rewrites any node.
  const lineOf = new Map();
  const walk = (n) => {
    if (ts.isBinaryExpression(n) && OPS.has(n.operatorToken.kind))
      lineOf.set(n, sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  const transformer = (ctx) => {
    const visit = (node) => {
      const line = lineOf.get(node);
      const out = ts.visitEachChild(node, visit, ctx);
      if (line === undefined) return out;
      return f.createCallExpression(
        f.createPropertyAccessExpression(f.createIdentifier('globalThis'), '__C'),
        undefined,
        [
          f.createStringLiteral(`${name}:${line}`),
          out.left,
          out.right,
          f.createNumericLiteral(OPS.get(node.operatorToken.kind)),
        ],
      );
    };
    return (root) => ts.visitNode(root, visit);
  };
  const res = ts.transform(sf, [transformer]);
  const text = ts.createPrinter().printFile(res.transformed[0]);
  res.dispose();
  return text;
}

const MATCH = /\/src\/(renderer|primitives|core|hitTest|svg\/pathBoolean|svg\/cubicCusp)/;
export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!MATCH.test(url) || !url.endsWith('.js')) return r;
  const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  return { ...r, source: instrument(src, url.replace(/.*\/src\//, '')), shortCircuit: true };
}
