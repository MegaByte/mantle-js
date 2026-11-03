// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Bundles derive fill variants from their content and warm them automatically.
// Legacy recolor declarations do not change the compiled variant.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ===========================================================================
console.log('\n-- the name is absent, and the note is present --');
{
  // A USE, not a mention: the note below necessarily names it, and so may a
  // comment explaining the decision. What must not exist is the name as a
  // callable, a property or a binding — i.e. an API that half-exists.
  const USE =
    /(?:^|[^A-Za-z0-9_.])registerFillUsage\s*[(=:]|\.registerFillUsage\b|\bregisterFillUsage\s*[,}]/;
  const skip = new Set(['node_modules', 'types', '.git', 'test', 'probes']);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = path.join(dir, name);
      // Internal design history is excluded from the public package.
      if (path.relative(ROOT, p) === path.join('docs', 'internal')) continue;
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(js|mjs|ts|md|json|glsl)$/.test(name)) continue;
      if (USE.test(readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  ok(
    hits.length === 0,
    `registerFillUsage exists as a name nowhere in the shipped tree (${hits.join(', ') || 'no hits'})`,
  );
}

// ===========================================================================
// ===========================================================================
console.log('\n-- what replaced it: the bundle declares ITSELF --');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const B = await import('../src/renderer/bundle.js');
const { attachFillPass } = await import('../src/renderer/fillPass.js');

// A renderer just complete enough for attachFillPass + fillWarmTick; R.program's
// tag is the observable, as in fillPrewarmOwnershipSmoke.
const makeGl = () =>
  new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null),
    },
  );
function makeRenderer(gl) {
  const warmed = [];
  const R = {
    gl,
    opts: {},
    draw: {},
    _lbFillMode: 'auto',
    _warmed: warmed,
    viewportSize: [0, 0],
    arScale: 1,
    dummyDashTex: null,
    dummyGradientTex: null,
    dummyGradientStops: null,
    IDENTITY_COLOR_MATRIX: new Float32Array(16),
    ZERO_OFFSET: new Float32Array(4),
    fillProg: {},
    shaderSources: { fillVert: '', fillFrag: '' },
    withDefines: (s) => s,
    program: (_v, _f, tag) => {
      warmed.push(tag);
      return {};
    },
    glEnable: () => {},
    glDisable: () => {},
    bindFb: () => {},
    glBindVertexArray: () => {},
    glViewport: () => {},
    glBlendFunc: () => {},
    mantleError: () => {},
    mantleWarn: () => {},
  };
  attachFillPass(R);
  warmed.length = 0;
  return R;
}
const keysOf = (R) =>
  R._warmed
    .filter((t) => t && t.startsWith('fill:prewarm:'))
    .map((t) => t.slice('fill:prewarm:'.length));

const SOLID =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#345" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';
const GRAD =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><defs>' +
  '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>' +
  '</defs><path fill="url(#g)" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';
{
  const gl = makeGl();
  const R = makeRenderer(gl);
  // No caller says anything about fills anywhere in these three lines.
  B.createBundle(gl, await importSvg(SOLID, { preserveViewport: true }));
  for (let i = 0; i < 4; i++) R.fillWarmTick();
  const solidKeys = keysOf(R);
  const legacy = [];
  for (const recolor of [false, true]) {
    const rg = makeGl(),
      rr = makeRenderer(rg);
    B.createBundle(rg, await importSvg(SOLID, { preserveViewport: true }), { recolor });
    for (let i = 0; i < 4; i++) rr.fillWarmTick();
    legacy.push(keysOf(rr).slice().sort());
  }
  ok(
    JSON.stringify(legacy[0]) === JSON.stringify(legacy[1]) &&
      JSON.stringify(legacy[0]) === JSON.stringify(solidKeys.slice().sort()),
    'legacy recolor declarations leave content-derived shader variants unchanged',
  );
  ok(
    solidKeys.length > 0,
    `creating a bundle is the whole declaration — it warmed ${solidKeys.length} variant(s) unprompted`,
  );

  const gl2 = makeGl();
  const R2 = makeRenderer(gl2);
  B.createBundle(gl2, await importSvg(GRAD, { preserveViewport: true }));
  for (let i = 0; i < 4; i++) R2.fillWarmTick();
  const gradKeys = keysOf(R2);
  ok(gradKeys.length > 0, 'and so does a bundle with a different paint');
  // The point: the define sets DIFFER, and the only thing that differed was the
  // artwork. A caller declaration could not have known this and could only have
  // repeated it.
  ok(
    JSON.stringify(solidKeys.slice().sort()) !== JSON.stringify(gradKeys.slice().sort()),
    `the two bundles compile DIFFERENT variants from their own content alone` +
      ` (solid ${JSON.stringify(solidKeys)} vs gradient ${JSON.stringify(gradKeys)})`,
  );
  ok(
    solidKeys.some((k) => /MANTLE_NO_GRADIENT/.test(k)) &&
      !gradKeys.some((k) => /MANTLE_NO_GRADIENT/.test(k)),
    'specifically: the solid bundle compiles the gradient code OUT and the gradient bundle keeps it',
  );
}

// ===========================================================================
console.log('\n-- and the explicit hooks a caller DOES get --');
{
  const api = readFileSync(path.join(ROOT, 'src', 'renderer', 'rendererApi.js'), 'utf8');
  for (const m of ['precompileFills', 'prewarmBundle']) {
    ok(new RegExp('\\b' + m + '\\b').test(api), `${m} is on the public renderer surface`);
  }
  ok(!/registerFillUsage/.test(api), 'and registerFillUsage is not');
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok(
    /precompileFills\(\)/.test(readme) && /prewarmBundle\(bundle\)/.test(readme),
    'both are documented, so a caller looking for "declare my fills" finds the real answer',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
