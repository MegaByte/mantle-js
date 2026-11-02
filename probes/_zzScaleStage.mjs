// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleStage — WHICH STAGE breaks scale invariance, not which pixel.
//
// A power-of-two scale is lossless through add, multiply, divide and sqrt, so every stage of the
// pipeline must be exactly EQUIVARIANT: run it on 2^k * input and the output must be 2^k * (the
// output on the input), bit for bit. That is a far sharper instrument than comparing frames -- it
// names the stage, and within a stage the first array that disagrees names the field.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { packLoopBlinnMesh } from '../src/renderer/lbPack.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
if (process.env.AUDIT_OFF) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__lbAuditOff = 1;
}
const KS = (process.env.KS || '-4,-2,-1,1,2,4').split(',').map(Number);
const sec = await importSvg(SVG, { preserveViewport: true });
const cf32 = new Float32Array(sec.curves);
const cf64 = sec.curves64 ? new Float64Array(sec.curves64) : cf32;
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);

/// LB contours are {type, p1..p4} with [x, y] arrays; the converter's are {t, P:[[x,y]..], w}.
/// FIELD BY FIELD, never BY SPREAD. Both engines memoise on the segment OBJECT -- its implicit, its
/// packed form, its arc geometry -- under symbol keys, and object spread copies enumerable own
/// symbols. A spread "scaled" segment therefore carries the UNSCALED implicit with it, and the
/// stage under test reads that instead of deriving one: 173 of 226 shapes failed to pack, which is
/// the test lying, not the converter.
const scaleLb = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { type: sg.type };
      for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = [sg[k][0] * S, sg[k][1] * S];
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
const scaleCv = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );

/// Every number a stage produced, flattened, so the comparison needs no knowledge of the shape of
/// the result. Coordinates scale; everything else must be identical, and mixing the two would hide
/// a defect either way -- so counts are compared first and separately.
/// TWO LISTS, NOT ONE. Coordinates scale with the input; a piece's sign, its type tag and its
/// Loop-Blinn klmn attributes do NOT (klmn is affine-normalized to the triangle), so folding them
/// into the scaled list would either excuse a real difference or invent one. The cubic HULLS and
/// the klmn payload are compared too; leaving them out reports a mesh exactly equivariant while
/// the pieces underneath it change representation.
function lbNums(m) {
  const pos = [],
    inv = [];
  for (const key of ['interior', 'fallback']) if (m[key]) for (const v of m[key]) pos.push(v);
  for (const key of ['quads', 'cubics', 'edges']) {
    if (!m[key]) continue;
    for (const e of m[key]) {
      if (Array.isArray(e)) {
        for (const p of e) {
          if (Array.isArray(p)) {
            pos.push(p[0]);
            pos.push(p[1]);
          } else pos.push(p);
        }
        continue;
      }
      for (const p of e.P || []) {
        if (Array.isArray(p)) {
          pos.push(p[0]);
          pos.push(p[1]);
        } else pos.push(p);
      }
      if (e.hull) for (const v of e.hull) pos.push(v);
      if (e.cp)
        for (const p of e.cp) {
          pos.push(p[0]);
          pos.push(p[1]);
        }
      // QUADS carry `tri` (positions) and `tc` (scale-free texture coords), plus the end normals
      // the kind-12 band packs. All of it is compared; otherwise a bundle could differ on a mesh
      // this probe calls equivariant.
      if (e.tri) for (const v of e.tri) pos.push(v);
      if (e.a) {
        pos.push(e.a[0]);
        pos.push(e.a[1]);
      }
      if (e.b) {
        pos.push(e.b[0]);
        pos.push(e.b[1]);
      }
      if (e.tc) {
        inv.push(4);
        for (const v of e.tc) inv.push(v);
      }
      inv.push(e.na ? 5 : 6);
      if (e.na) {
        inv.push(e.na[0]);
        inv.push(e.na[1]);
      }
      inv.push(e.nb ? 7 : 8);
      if (e.nb) {
        inv.push(e.nb[0]);
        inv.push(e.nb[1]);
      }
      if (e.w !== undefined) inv.push(e.w);
      if (e.klmn) {
        inv.push(1);
        for (const v of e.klmn) inv.push(v);
      } else inv.push(0);
      // F is the Bezout implicit -- an object of coefficients, not an array -- and its magnitude
      // moves with the coordinate scale, so only its PRESENCE is scale-free.
      inv.push(e.F ? 2 : 3);
      if (e.sign !== undefined) inv.push(e.sign);
    }
  }
  return { pos, inv };
}
const cvNums = (ps) => {
  const o = [];
  for (const p of ps)
    for (const c of p.curves)
      for (const q of c.P) {
        o.push(q[0]);
        o.push(q[1]);
      }
  return o;
};

let pkShapes = 0,
  pkBad = 0;
const pkCount = [];
let cwShapes = 0,
  cwBad = 0;
const cwCount = [];
let lbShapes = 0,
  lbBad = 0,
  cvShapes = 0,
  cvBad = 0,
  lbWorst = 0,
  cvWorst = 0;
const lbShapesBad = [],
  cvShapesBad = [],
  lbCount = [],
  cvCount = [];
const lbWhy = new Map(),
  cvWhy = new Map();
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  const lbC = curveRangeToContours(cf32, r.begin | 0, r.end | 0);
  const cvC = contoursToConverter(curveRangeToContours(cf64, r.begin | 0, r.end | 0), null);
  // ---- Loop-Blinn mesh ----
  if (lbC && lbC.length) {
    let base = null;
    try {
      base = buildLoopBlinnCDT(scaleLb(lbC, 1), { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
    } catch {
      base = null;
    }
    if (base) {
      lbShapes++;
      const b = lbNums(base);
      for (const k of KS) {
        const S = Math.pow(2, k);
        let m = null;
        try {
          m = buildLoopBlinnCDT(scaleLb(lbC, S), { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
        } catch {
          m = null;
        }
        if (!m) {
          lbBad++;
          lbCount.push(s + ':build');
          lbWhy.set('build failed', (lbWhy.get('build failed') | 0) + 1);
          break;
        }
        const a = lbNums(m);
        if (a.pos.length !== b.pos.length || a.inv.length !== b.inv.length) {
          lbBad++;
          // WHICH ARRAY changed, not just that something did.
          const per = (m) =>
            ['interior', 'fallback', 'quads', 'cubics', 'edges']
              .map((k) => `${k}:${m[k] ? m[k].length : 0}`)
              .join(' ');
          lbCount.push(`${s}@2^${k}[${per(base)} | ${per(m)}]`);
          lbWhy.set('different vertex COUNT', (lbWhy.get('different vertex COUNT') | 0) + 1);
          break;
        }
        // The scale-free half must match to the last bit; nothing about it depends on size.
        let ibad = -1;
        for (let i = 0; i < a.inv.length; i++)
          if (a.inv[i] !== b.inv[i]) {
            ibad = i;
            break;
          }
        if (ibad >= 0) {
          lbBad++;
          lbCount.push(`${s}:attr@2^${k}`);
          lbWhy.set(
            'scale-free ATTRIBUTES differ',
            (lbWhy.get('scale-free ATTRIBUTES differ') | 0) + 1,
          );
          break;
        }
        // ULP NOISE IS NOT A THRESHOLD. Math.hypot and the trig functions are not bit-exact under
        // a power-of-two scale even though they are mathematically invariant, so a last-place
        // difference says nothing. A RELATIVE difference far above that is a different decision.
        let rel = 0;
        for (let i = 0; i < a.pos.length; i++) {
          const e = Math.abs(a.pos[i] / S - b.pos[i]),
            m = Math.max(Math.abs(b.pos[i]), 1e-300);
          if (e / m > rel) rel = e / m;
        }
        if (rel > 1e-9) {
          lbBad++;
          lbWorst = Math.max(lbWorst, rel);
          lbShapesBad.push(s);
          lbWhy.set(
            'same count, different VALUES',
            (lbWhy.get('same count, different VALUES') | 0) + 1,
          );
          break;
        }
      }
      // THE PACKED BUNDLE, not only the mesh. The wire is what the GPU sees, and it carries
      // derived quantities (gradients, band frames, kind codes) the mesh does not -- so a mesh
      // that is exactly equivariant can still pack to a different bundle.
      let pk0 = null;
      try {
        pk0 = packLoopBlinnMesh(base);
      } catch {
        pk0 = null;
      }
      if (pk0 && pk0.verts) {
        pkShapes++;
        for (const k of KS) {
          const S = Math.pow(2, k);
          let m2 = null,
            pk = null;
          try {
            m2 = buildLoopBlinnCDT(scaleLb(lbC, S), { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
          } catch {
            m2 = null;
          }
          try {
            pk = m2 ? packLoopBlinnMesh(m2) : null;
          } catch {
            pk = null;
          }
          if (!pk || !pk.verts || pk.verts.length !== pk0.verts.length) {
            pkBad++;
            pkCount.push(`${s}:verts@2^${k}`);
            break;
          }
          // A VERTEX STREAM MIXES DEGREES: positions scale as S, gradients as 1/S, areas as S^2,
          // and kind codes not at all. A component is equivariant if SOME integer power of the
          // scale maps it onto the reference -- so the test is "is there one", not "is it this
          // one", and only a component with no consistent exponent is a real difference.
          // PACKED LANES ARE BIT PATTERNS, not numbers. CURVE_BAND puts two half floats in one
          // float32 slot (packHalf2x16), so the stored value is a reinterpreted uint and no power
          // of the scale relates two of them -- comparing it numerically invents a difference
          // wherever the quantities it packs legitimately scale. The lanes it packs are listed
          // rather than guessed: 9 (dk, dl) and 15/16 (the two own-normals).
          const PACKED = { 12: new Set([9, 15, 16]) };
          let bad2 = -1;
          for (let i = 0; i < pk.verts.length; i++) {
            const a2 = pk.verts[i],
              b2 = pk0.verts[i];
            if (a2 === b2) continue;
            const kd = pk.verts[Math.floor(i / 24) * 24 + 5] | 0;
            if (PACKED[kd] && PACKED[kd].has(i % 24)) continue;
            const m2 = Math.max(Math.abs(b2), 1e-30);
            let okAny = false;
            for (let e = -3; e <= 3 && !okAny; e++)
              if (Math.abs(a2 / Math.pow(S, e) - b2) <= 1e-6 * m2) okAny = true;
            if (!okAny) {
              bad2 = i;
              if (!globalThis._pkFirst && (!process.env.PKSHAPE || +process.env.PKSHAPE === s)) {
                const vb = Math.floor(i / 24) * 24;
                globalThis._pkFirst = `s${s} lane${i % 24} vert${Math.floor(i / 24)} S=${S}\n    scaled: ${Array.from(
                  pk.verts.slice(vb, vb + 24),
                )
                  .map((x) => x.toExponential(4))
                  .join(' ')}\n    base:   ${Array.from(pk0.verts.slice(vb, vb + 24))
                  .map((x) => x.toExponential(4))
                  .join(' ')}`;
              }
              break;
            }
          }
          if (bad2 >= 0) {
            pkBad++;
            pkCount.push(`${s}:lane${bad2 % 24}@2^${k}`);
            break;
          }
        }
      }
    }
  }
  // ---- CPatch decomposition ----
  if (cvC && cvC.length) {
    const ps0 = [];
    try {
      packCPatchShape(scaleCv(cvC, 1), 0, { evenOdd, onPatches: (a) => ps0.push(...a) });
    } catch {
      continue;
    }
    if (!ps0.length) continue;
    cvShapes++;
    const b = cvNums(ps0);
    for (const k of KS) {
      const S = Math.pow(2, k);
      const ps = [];
      try {
        packCPatchShape(scaleCv(cvC, S), 0, { evenOdd, onPatches: (a) => ps.push(...a) });
      } catch {
        ps.length = 0;
      }
      if (!ps.length) {
        cvBad++;
        cvWhy.set('pack failed', (cvWhy.get('pack failed') | 0) + 1);
        break;
      }
      if (ps.length !== ps0.length) {
        cvBad++;
        cvCount.push(`${s}(${ps0.length}->${ps.length}@2^${k})`);
        cvWhy.set('different PATCH count', (cvWhy.get('different PATCH count') | 0) + 1);
        break;
      }
      const a = cvNums(ps);
      if (a.length !== b.length) {
        cvBad++;
        cvCount.push(`${s}(curves@2^${k})`);
        cvWhy.set('different curve count', (cvWhy.get('different curve count') | 0) + 1);
        break;
      }
      let rel = 0;
      for (let i = 0; i < a.length; i++) {
        const e = Math.abs(a[i] / S - b[i]),
          m = Math.max(Math.abs(b[i]), 1e-300);
        if (e / m > rel) rel = e / m;
      }
      if (rel > 1e-9) {
        cvBad++;
        cvWorst = Math.max(cvWorst, rel);
        cvShapesBad.push(s);
        cvWhy.set(
          'same count, different VALUES',
          (cvWhy.get('same count, different VALUES') | 0) + 1,
        );
        break;
      }
    }
    // ...AND THE WIRE. The decomposition being equivariant says nothing about the TEXELS the
    // kernel reads: those carry implicit coefficients, hull planes and cover quads, all derived.
    let w0 = null;
    try {
      w0 = packCPatchShape(scaleCv(cvC, 1), 0, { evenOdd });
    } catch {
      w0 = null;
    }
    if (w0 && w0.texels) {
      cwShapes++;
      for (const k of KS) {
        const S = Math.pow(2, k);
        let w = null;
        try {
          w = packCPatchShape(scaleCv(cvC, S), 0, { evenOdd });
        } catch {
          w = null;
        }
        if (
          !w ||
          !w.texels ||
          w.texels.length !== w0.texels.length ||
          w.verts.length !== w0.verts.length
        ) {
          cwBad++;
          cwCount.push(`${s}:len@2^${k}`);
          break;
        }
        // As on the LB side: a lane is equivariant if SOME integer power of the scale maps it.
        let bad3 = -1;
        for (const [arr, ref, tag] of [
          [w.texels, w0.texels, 'tex'],
          [w.verts, w0.verts, 'vert'],
        ]) {
          for (let i = 0; i < arr.length; i++) {
            const a3 = arr[i],
              b3 = ref[i];
            if (a3 === b3) continue;
            const m3 = Math.max(Math.abs(b3), 1e-30);
            let ok3 = false;
            for (let e = -4; e <= 4 && !ok3; e++)
              if (Math.abs(a3 / Math.pow(S, e) - b3) <= 1e-6 * m3) ok3 = true;
            if (!ok3) {
              bad3 = i;
              cwCount.push(`${s}:${tag}${i}@2^${k}`);
              if (!globalThis._cwFirst)
                globalThis._cwFirst = `s${s} ${tag}[${i}] S=${S}  ${a3} vs ${b3}`;
              break;
            }
          }
          if (bad3 >= 0) break;
        }
        if (bad3 >= 0) {
          cwBad++;
          break;
        }
      }
    }
  }
}
console.log(`scales 2^${KS.join(', 2^')}`);
console.log(
  `Loop-Blinn mesh:  ${lbBad} of ${lbShapes} shapes are NOT equivariant` +
    (lbWhy.size ? '  [' + [...lbWhy].map(([k, v]) => `${k}: ${v}`).join(', ') + ']' : ''),
);
console.log(
  `CPatch patches:   ${cvBad} of ${cvShapes} shapes are NOT equivariant` +
    (cvWhy.size ? '  [' + [...cvWhy].map(([k, v]) => `${k}: ${v}`).join(', ') + ']' : ''),
);
console.log(
  `  worst RELATIVE value difference: LB ${lbWorst.toExponential(2)}, CPatch ${cvWorst.toExponential(2)}`,
);
if (globalThis._pkFirst) console.log('  first packed difference: ' + globalThis._pkFirst);
console.log(
  `LB packed bundle: ${pkBad} of ${pkShapes} shapes are NOT equivariant` +
    (pkCount.length ? '  [' + pkCount.slice(0, 8).join(' ') + ']' : ''),
);
console.log(`  LB structural: ${lbCount.slice(0, 10).join(' ') || 'none'}`);
if (globalThis._cwFirst) console.log('  first CPatch wire difference: ' + globalThis._cwFirst);
console.log(
  `CPatch wire:      ${cwBad} of ${cwShapes} shapes are NOT equivariant` +
    (cwCount.length ? '  [' + cwCount.slice(0, 6).join(' ') + ']' : ''),
);
console.log(`  CPatch structural: ${cvCount.slice(0, 8).join(' ') || 'none'}`);
