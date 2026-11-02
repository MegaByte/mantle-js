// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU arc winding uses stored endpoints at every scale; the rounding bound scales with coordinates.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { arcRayUlp, bandFillCoverage } from '../src/hitTest/bandWinding.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the module under test, and a mutation of it ----------------------------------------
// bandWinding.js imports nothing, so a variant is the source with one line rewritten, loaded from a data: URL. That
// keeps the A/B on the REAL walker instead of a second copy of it that could drift.
const SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const ENDS = 'const pLo = dir > 0 ? pS : pE,\n        pHi = dir > 0 ? pE : pS;';
ok(
  SRC.includes(ENDS),
  'bandWinding.js reads the arc ends from the record on one line (the A/B hinge)',
);
const REBUILT = await import(
  'data:text/javascript;base64,' +
    Buffer.from(SRC.replace(ENDS, 'const pLo = at(lo), pHi = at(hi);')).toString('base64')
); // the ends rebuilt, no snap

// ---- (a) one asset, three coordinate scales ---------------------------------------------
// A box with a notch cut into its top edge. The notch's left side is an ARC that arrives at
// the apex (50,50) and its right side a line that leaves it, so a scanline at y = 50 TOUCHES
// the apex: the line counts it as non-negative, and the arc cancels that only if its end lands on
// the same side -- which it does exactly when the end is the stored vertex.
const notch = (S) => {
  const n = (v) => +(v * S).toPrecision(17);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(100)} ${n(100)}"><path d="M ${n(10)} ${n(10)} L ${n(35)} ${n(10)} A ${n(30)} ${n(30)} 0 0 0 ${n(50)} ${n(50)} L ${n(60)} ${n(10)} L ${n(90)} ${n(10)} L ${n(90)} ${n(90)} L ${n(10)} ${n(90)} Z"/></svg>`;
};
const XS = [15, 20, 30, 40, 45]; // all well inside the box on all three rows
const PX_PER_EM = 5.12; // the 100-em asset drawn at 512 px, at any scale

async function rows(mod, S) {
  const b = await importSvg(notch(S), { preserveViewport: true });
  const MF = parseMetaBin(b.meta, b.metaFloatsPerShape).metaFloats;
  const bandF = new Float32Array(b.bands),
    curveF = new Float32Array(b.curves);
  const gd = [
    MF[M.META_GLYPH_LOC_X],
    MF[M.META_GLYPH_LOC_Y],
    MF[M.META_BAND_MAX_X],
    MF[M.META_BAND_MAX_Y],
  ];
  const bb = [
    MF[M.META_BBOX_XMIN],
    MF[M.META_BBOX_YMIN],
    MF[M.META_BBOX_XMAX],
    MF[M.META_BBOX_YMAX],
  ];
  const pp = PX_PER_EM / S;
  const at = (y) =>
    XS.map((x) => mod.bandFillCoverage(bandF, curveF, gd, bb, x * S, y * S, pp, pp, false));
  return { above: at(49), touch: at(50), below: at(51) };
}
const fmt = (a) => a.map((v) => v.toFixed(2)).join(' ');
const SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];

const report = [];
for (const [name, mod] of [
  ['stored ends (shipped)', { bandFillCoverage }],
  ['rebuilt ends (mutation)', REBUILT],
]) {
  const bad = [];
  for (const S of SCALES) {
    const r = await rows(mod, S);
    if (fmt(r.touch) !== fmt(r.above) || fmt(r.touch) !== fmt(r.below))
      bad.push(`2^${Math.round(Math.log2(S))}`);
    report.push(
      `    ${name.padEnd(23)} 2^${String(Math.round(Math.log2(S))).padStart(3)}  above ${fmt(r.above)} | touch ${fmt(r.touch)}`,
    );
  }
  if (name.startsWith('stored'))
    ok(
      bad.length === 0,
      `(a) the touched row matches its neighbors at every scale (${bad.length ? 'differs at ' + bad.join(', ') : '3 of 3 scales clean'})`,
    );
  else
    ok(
      bad.length > 0,
      `(a) non-vacuous: ${name} loses the row at ${bad.length || 'NO'} of 3 scales${bad.length ? ' (' + bad.join(', ') + ')' : ''}`,
    );
}
console.log(report.join('\n'));

// ...and the same answer at every scale
{
  const rel = new Set();
  for (const S of SCALES) rel.add(fmt((await rows({ bandFillCoverage }, S)).touch));
  ok(
    rel.size === 1,
    `(a) the stored ends give ${rel.size} answer for ONE asset across the sweep (the same at every scale)`,
  );
}

// ---- (b) homogeneity: the property that makes (a) hold for ANY asset ---------------------
{
  let worst = 0,
    n = 0;
  for (const [cy, rx, ry] of [
    [50, 30, 30],
    [0.004, 0.0012, 0.0031],
    [91234, 17, 3.5],
    [-7, 0.5, 900],
  ]) {
    for (const k of [Math.pow(2, -30), Math.pow(2, -8), 4, Math.pow(2, 24)]) {
      const got = arcRayUlp(cy * k, rx * k, ry * k),
        want = arcRayUlp(cy, rx, ry) * k;
      worst = Math.max(worst, Math.abs(got - want) / want);
      n++;
    }
  }
  ok(
    worst === 0,
    `(b) arcRayUlp(k·x) == k·arcRayUlp(x) exactly over ${n} cases (worst relative gap ${worst})`,
  );
  ok(arcRayUlp(1, 1, 1) !== arcRayUlp(2, 2, 2), '(b) and it is not a constant in disguise');
}

if (fail) {
  console.error(`SLUG-ARC-RAY-TOLERANCE FAIL (${fail})`);
  process.exit(1);
}
console.log('SLUG-ARC-RAY-TOLERANCE PASS');
