// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPresenceSmoke — under kernel 'auto', a unified draw compiles AAC only when its cover rows pay for its
// PRESENCE in every other fragment (coverKernelPolicy.aacPresenceTerms).
//
// A unified draw with no cover fill row never compiles AAC. For draws WITH one, a bundle-mean vote is not enough:
// tiger @512 binding AAC for ONE cover row among 223 Loop-Blinn meshes is 1.19-1.59x slower on the GPU, because
// AAC's registers are allocated for the whole program and every mesh fragment runs at its occupancy. The model
// prices both sides, in device px^2 of row bbox:
//
//   gain      sum over AA cover rows of F * (1 - rho)   rho 0.78 above the row's type floor, 1.11 below
//   presence  0.20 * sum over every other painted row of F
//
// HOW: the real renderer on test/_fakeGl.mjs (no GPU), warmed until a variant is BOUND (prewarmBundle +
// precompileFills), then the bound key read back.
//   (a) tiger @512 and @1024 (skipped when the gitignored fixture is absent): one AA cover row against ~7e6 px^2
//       of meshes -- no MANTLE_AAC (a bundle-mean vote binds it), and the draw was priced (gain and
//       presence reported, gain < presence);
//   (b) one big line-only star (cover: the per-shape policy leaves line rows to the cover kernel) behind three
//       small cubic blobs (meshes): AAC IS bound, so (a) is the model and not a policy that stopped choosing AAC;
//   (c) the inverse -- a small star and four big blobs: no AAC (the bundle mean, dominated by the blobs Loop-Blinn
//       draws, bound it before: the second failing arm);
//   (d) the classic route (route 'none') is not priced by the model: the same bundle keeps the fitted mean rule;
//   (e) aacPresenceTerms by hand, on a three-row bundle.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const P = await import('../src/renderer/coverKernelPolicy.js');
const warn = console.warn;
console.warn = () => {};

const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy}` +
  ` C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const star = (cx, cy, R, r, n) => {
  let d = '';
  for (let i = 0; i < 2 * n; i++) {
    const a = (Math.PI * i) / n,
      q = i & 1 ? r : R;
    d += `${i ? 'L' : 'M'}${(cx + q * Math.cos(a)).toFixed(2)} ${(cy + q * Math.sin(a)).toFixed(2)}`;
  }
  return d + 'Z';
};
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const BG = svg(
  `<path d="${star(50, 50, 48, 30, 12)}" fill="#8e44ad"/>${[
    [30, 40],
    [60, 55],
    [45, 70],
  ]
    .map(([x, y], i) => `<path d="${blob(x, y, 4)}" fill="hsl(${i * 80},60%,45%)"/>`)
    .join('')}`,
);
const INV = svg(
  `<path d="${star(50, 50, 6, 3, 12)}" fill="#8e44ad"/>${[
    [28, 28],
    [72, 28],
    [28, 72],
    [72, 72],
  ]
    .map(([x, y], i) => `<path d="${blob(x, y, 18)}" fill="hsl(${i * 80},60%,45%)"/>`)
    .join('')}`,
);

async function bound(text, { size = 1024, route = 'auto', kernel = 'auto' } = {}) {
  const F = createFakeGl({ width: size, height: size });
  // A static bundle takes the cover pass under 'auto' (fillRouteClass.js); this smoke is about the PRESENCE model of a unified draw, so it opts the static bundle back into the unified route (staticUnified) and keeps the per-shape 'auto' picks.
  const R = createRenderer(
    F.gl,
    taggedShaderSources(),
    route === 'none' ? {} : { staticUnified: true },
  );
  R.setFillEngine({ route, kernel });
  const b = createBundle(F.gl, await importSvg(text, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 60000);
    } catch {
      /* the key check reports it */
    }
  }
  R.setViewport(size, size);
  R.prewarmBundle(b);
  let key = '';
  for (let i = 0; i < 24; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    R.precompileFills();
    key = R.debugStats.drawnFillVariantKey || '';
    if (i >= 2 && key) break;
  }
  const ds = R.debugStats;
  const out = {
    key,
    defs: new Set(key.split('|')),
    gate: ds.unifiedFillGate,
    gain: ds.autoAacGain,
    presence: ds.autoAacPresence,
  };
  try {
    R.dispose();
  } catch {
    /* headless */
  }
  return out;
}
const aac = (r) => r.defs.has('MANTLE_AAC');
const terms = (r) => `gain ${Math.round(r.gain)} px^2, presence ${Math.round(r.presence)} px^2`;

// ---- (a) ----------------------------------------------------------------------------------------------------------
const TIGER = path.join(ROOT, 'examples/tiger.svg');
if (existsSync(TIGER)) {
  const text = readFileSync(TIGER, 'utf8');
  for (const size of [512, 1024]) {
    const r = await bound(text, { size });
    ok(
      r.gate === 'on' &&
        r.defs.has('MANTLE_LB_FILL') &&
        !aac(r) &&
        r.presence > 0 &&
        r.presence > r.gain,
      `(a) tiger @${size}: one AA cover row among the meshes does not pay for AAC (${aac(r) ? 'AAC bound' : 'no AAC'}; ${terms(r)})`,
    );
  }
} else console.log('  skip (a) examples/tiger.svg is absent (gitignored fixture)');

// ---- (b) (c) ------------------------------------------------------------------------------------------------------
{
  const r = await bound(BG);
  ok(
    r.gate === 'on' && r.defs.has('MANTLE_LB_FILL') && aac(r) && r.gain > r.presence,
    `(b) a big line-only cover row behind small meshes: AAC is bound (${terms(r)})`,
  );
}
{
  const r = await bound(INV);
  ok(
    r.gate === 'on' && r.defs.has('MANTLE_LB_FILL') && !aac(r) && r.presence > r.gain,
    `(c) a small cover row among big meshes: no AAC (${aac(r) ? 'AAC bound' : 'no AAC'}; ${terms(r)})`,
  );
}

// ---- (d) ----------------------------------------------------------------------------------------------------------
{
  const r = await bound(INV, { route: 'none' });
  ok(
    !r.defs.has('MANTLE_LB_FILL') && aac(r) && r.gain === -1 && r.presence === -1,
    `(d) the classic route keeps the fitted mean rule and is not priced (${aac(r) ? 'AAC' : 'Slug'}; gain ${r.gain})`,
  );
}

// ---- (e) ----------------------------------------------------------------------------------------------------------
{
  // three rows, bbox 10x10, 20x20 and 30x30 units at k2 = 10 px^2 per unit^2: 1e3, 4e3 and 9e3 px^2
  const st = 32,
    meta = new Float32Array(3 * st);
  [10, 20, 30].forEach((w, s) => {
    meta[s * st + 2] = w;
    meta[s * st + 3] = w;
    meta[s * st + 7] = 1;
  });
  const bundle = { metaFloats: meta, metaFloatsPerShape: st, segTypeMask: 1 << 2 };
  const cubic = new Uint8Array([4, 4, 4]);
  // row 0 AA cover (1e3 < 3e3 cubic floor: rho 1.11), row 1 AA cover (4e3: rho 0.78), row 2 a mesh (9e3)
  const t = P.aacPresenceTerms(
    bundle,
    new Uint8Array([P.ROW_COVER_AA, P.ROW_COVER_AA, P.ROW_MESH]),
    cubic,
    10,
  );
  const gain = 1e3 * (1 - P.AAC_RHO_BELOW) + 4e3 * (1 - P.AAC_RHO_ABOVE),
    presence = P.AAC_PRESENCE * 9e3;
  ok(
    Math.abs(t.gain - gain) < 1e-6 && Math.abs(t.presence - presence) < 1e-6 && t.rows === 2,
    `(e) terms by hand: gain ${t.gain.toFixed(1)} (want ${gain.toFixed(1)}), presence ${t.presence.toFixed(1)} (want ${presence.toFixed(1)})`,
  );
  ok(
    !P.aacPaysPresence(
      bundle,
      new Uint8Array([P.ROW_COVER_AA, P.ROW_COVER_AA, P.ROW_MESH]),
      cubic,
      10,
    ) &&
      P.aacPaysPresence(
        bundle,
        new Uint8Array([P.ROW_MESH, P.ROW_NONE, P.ROW_COVER_AA]),
        cubic,
        10,
      ) &&
      !P.aacPaysPresence(
        bundle,
        new Uint8Array([P.ROW_MESH, P.ROW_COVER_HARD, P.ROW_OTHER_QUAD]),
        cubic,
        10,
      ),
    '(e) verdicts: 770 vs 1800 -> Slug; one big AA row over a small mesh -> AAC; no AA cover row -> Slug',
  );
}

console.warn = warn;
console.log(fail ? `\naacPresenceSmoke FAIL (${fail})` : '\naacPresenceSmoke PASS');
process.exit(fail ? 1 : 0);
