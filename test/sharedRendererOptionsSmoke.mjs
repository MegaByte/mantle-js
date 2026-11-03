// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sharedRendererOptionsSmoke — two renderers built from ONE options object do not share an engine selection.
//
// setFillEngine writes the selection into R.opts, so if createRenderer kept the object it was handed as R.opts, an
// app that passed one options object to two renderers would have the first renderer's route and kernel carried into
// the second: `aacFill: true` written by the first baked into the second's BASE program at construction, a CPatch
// route drawing CPatch on both, and the app's own object rewritten. createRenderer copies the options.
// Checked on the real renderer over test/_fakeGl.mjs (no GPU), by getFillEngine and by the program a draw binds:
//   (a) A.setFillEngine does not write into the caller's object;
//   (b) B, built from that object afterwards, reports the default selection and its bound program has no MANTLE_AAC;
//   (c) B.setFillEngine does not move A, and A's bound program still carries MANTLE_AAC;
//   (d) an option the caller DID pass (aacFill: true) still reaches both renderers;
//   (e) two renderers built from one object BEFORE either selects: one choosing CPatch does not route the other.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 20 L50 90 Z" fill="#48c"/></svg>';
const sec = await importSvg(SVG);
const make = (opts) => {
  const F = createFakeGl({ width: 128, height: 128 });
  return { F, R: createRenderer(F.gl, taggedShaderSources(), opts) };
};
// The defines of the program a draw bound. The route is pinned to 'none' for the draw so the cover kernel is the
// only thing asked; the BASE program draws until a variant warms, and either carries a baked kernel.
function boundDefs({ F, R }) {
  const b = createBundle(F.gl, sec);
  R.setViewport(128, 128);
  R.prewarmBundle(b);
  let key = null;
  for (let i = 0; i < 8; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    R.precompileFills();
    key = R.debugStats.drawnFillVariantKey;
    if (i >= 2 && key) break;
  }
  return new Set(String(key || '').split('|'));
}

const opts = { viewCull: false };
const A = make(opts);
const def = A.R.getFillEngine();
A.R.setFillEngine({ route: 'cpatch', kernel: 'aac' });
// (a)
ok(
  JSON.stringify(opts) === '{"viewCull":false}',
  `(a) setFillEngine leaves the caller's object alone (${JSON.stringify(opts)})`,
);
// (b)
const B = make(opts);
const eb = B.R.getFillEngine();
ok(
  eb.route === def.route && eb.kernel === def.kernel,
  `(b) a renderer built from the same object afterwards reports the default (${eb.route}/${eb.kernel}, default ${def.route}/${def.kernel})`,
);
B.R.setFillEngine({ route: 'none' });
const bDefs = boundDefs(B);
ok(
  !bDefs.has('MANTLE_AAC'),
  `(b) ...and its bound program has no MANTLE_AAC (${[...bDefs].filter(Boolean).join('|') || 'base'})`,
);
// (c)
B.R.setFillEngine({ route: 'lb', kernel: 'slug' });
const ea = A.R.getFillEngine();
ok(
  ea.route === 'cpatch' && ea.kernel === 'aac',
  `(c) the second renderer's selection does not move the first (${ea.route}/${ea.kernel})`,
);
A.R.setFillEngine({ route: 'none' });
const aDefs = boundDefs(A);
ok(aDefs.has('MANTLE_AAC'), '(c) ...and the first still binds its own kernel (MANTLE_AAC)');
// (d)
const shared = { aacFill: true };
const C = make(shared),
  D = make(shared);
ok(
  C.R.getFillEngine().kernel === 'aac' && D.R.getFillEngine().kernel === 'aac',
  '(d) an option the caller passed reaches both renderers',
);
C.R.setFillEngine({ kernel: 'slug' });
ok(
  shared.aacFill === true && D.R.getFillEngine().kernel === 'aac',
  '(d) ...and one renderer changing it moves neither the object nor the other',
);
C.R.setFillEngine({ route: 'none' });
D.R.setFillEngine({ route: 'none' });
ok(boundDefs(D).has('MANTLE_AAC'), '(d) ...whose bound program carries MANTLE_AAC');

// (e)
const pair = {};
const E = make(pair),
  G = make(pair);
E.R.setFillEngine({ route: 'cpatch', kernel: 'hard-band' });
const eg = G.R.getFillEngine();
ok(
  eg.route === def.route && eg.kernel === def.kernel,
  `(e) renderers built together: one selecting leaves its sibling at the default (${eg.route}/${eg.kernel})`,
);

for (const X of [A, B, C, D, E, G]) {
  try {
    X.R.dispose();
  } catch {
    /* headless */
  }
}
console.log(
  fail ? `\nsharedRendererOptionsSmoke FAIL (${fail})` : '\nsharedRendererOptionsSmoke PASS',
);
process.exit(fail ? 1 : 0);
