// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleCmpTrace — the FIRST comparison whose outcome differs between a stage run at scale 1 and at 2^k.
//
// A power-of-two scale is exact through + - * / sqrt, so the two runs perform the same comparisons with the
// same outcomes, in the same order, until one of them compares against something that did not scale. Every
// comparison in src/ is rewritten into a traced call (_zzCmpTraceHooks), the scale-1 run records the
// sequence of (site, outcome), and the 2^k run stops at the first entry that disagrees -- which IS the
// comparison to fix, printed with its operands at both scales so the constant is visible.
//
//   node probes/_zzScaleCmpTrace.mjs FILE.svg SHAPE K [STAGE]     STAGE = lbShape | lbCdt | cpatch | graph | resolve
import { register } from 'module';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
const { readFileSync, writeFileSync } = await import('fs');
const ROLE = process.env.__TRACE_ROLE || '';
const TMP = process.env.__TRACE_FILE || '';
if (!ROLE) {
  // DRIVER: each run in a FRESH PROCESS. Module-level memos (quotient tables, caches keyed by
  // normalized geometry) survive a run, so a second run in the same process takes different paths
  // for reasons that have nothing to do with scale.
  const me = fileURLToPath(import.meta.url);
  const tmp = (process.env.TMPDIR || '/tmp') + '/cmptrace-' + process.pid;
  const run = (role, extra = {}) =>
    spawnSync(process.execPath, [me, ...process.argv.slice(2)], {
      env: { ...process.env, __TRACE_ROLE: role, __TRACE_FILE: tmp, ...extra },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
  const a = run('rec');
  if (a.status !== 0) {
    console.log(a.stdout, a.stderr);
    process.exit(1);
  }
  const b = run('cmp');
  process.stdout.write(b.stdout);
  if (b.status !== 0) {
    console.log(b.stderr);
    process.exit(1);
  }
  const m = /FIRST DIFFERENCE at comparison #(\d+)/.exec(b.stdout);
  if (m) {
    const c = run('peek', { __TRACE_PEEK: m[1] });
    process.stdout.write(c.stdout);
  }
  process.exit(0);
}
register('./_zzCmpTraceHooks.mjs', import.meta.url);
// GLOBALS=name=value,...: switches set before the modules load (true/false/numbers), e.g. to take one
// known divergence out of the way while tracing the next.
for (const kv of (process.env.GLOBALS || '').split(',').filter(Boolean)) {
  const [k9, v9] = kv.split('=');
  globalThis[k9] = v9 === 'true' ? true : v9 === 'false' ? false : Number(v9);
}
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

let mode = 'off',
  ids = new Map(),
  names = [],
  seq = new Int32Array(1 << 20),
  n = 0,
  at = 0,
  div = null;
let ref = null,
  refNames = null;
const peekAt = ROLE === 'peek' ? +process.env.__TRACE_PEEK : -1;
let peek = null;
const ring = [];
// IGNORE=site,site: comparisons that decide nothing downstream and are known to differ (the half-float packer's
// range tests), left out of both sequences so they neither report nor misalign what follows.
const IGNORE = new Set(
  (process.env.IGNORE || 'renderer/lbPack.js:32,renderer/lbPack.js:33').split(',').filter(Boolean),
);
globalThis.__C = (id, a, b, op) => {
  const r =
    op === 0
      ? a < b
      : op === 1
        ? a > b
        : op === 2
          ? a <= b
          : op === 3
            ? a >= b
            : op === 4
              ? a == b
              : op === 5
                ? a != b
                : op === 6
                  ? a === b
                  : a !== b;
  if (mode === 'off' || IGNORE.has(id)) return r;
  let k = ids.get(id);
  if (k === undefined) {
    k = names.length;
    names.push(id);
    ids.set(id, k);
  }
  if (mode === 'rec') {
    if (n === seq.length) {
      const g = new Int32Array(seq.length * 2);
      g.set(seq);
      seq = g;
      if (OPS) {
        const h = new Float64Array(g.length * 2);
        h.set(opv);
        opv = h;
      }
    }
    if (n === peekAt) peek = { id, a, b, r };
    if (OPS) {
      opv[2 * n] = typeof a === 'number' ? a : NaN;
      opv[2 * n + 1] = typeof b === 'number' ? b : NaN;
    }
    seq[n++] = k * 2 + (r ? 1 : 0);
  } else if (mode === 'cmp' && !div) {
    ring.push(id);
    if (ring.length > 12) ring.shift();
    const rc = at < ref.length ? ref[at] : -1;
    if (rc < 0 || refNames[rc >> 1] !== id || !!(rc & 1) !== r)
      div = {
        at,
        id,
        a,
        b,
        r,
        ref: rc < 0 ? '(past end)' : refNames[rc >> 1],
        refR: rc < 0 ? null : !!(rc & 1),
        ctx: ring.slice(0, -1),
      };
    // OPERANDS=1: the first comparison whose NUMBERS stop being a power of the scale times the reference's,
    // even though its outcome agrees -- arithmetic that does not scale (an `x + 1`, a floor inside a max) is
    // invisible to the outcome sequence until it has moved something far enough to flip a comparison.
    else if (OPS && !opDiv && refOps) {
      const eqP = (x, y) => {
        if (x === y || (x !== x && y !== y)) return true;
        if (!isFinite(x) || !isFinite(y) || x === 0 || y === 0) return false;
        for (let e = -12, p = S ** -12; e <= 12; e++, p *= S)
          if (Math.abs(x / p - y) <= OPTOL * Math.abs(y)) return true;
        return false;
      };
      const ra = refOps[2 * at],
        rb = refOps[2 * at + 1];
      if ((typeof a === 'number' && !eqP(a, ra)) || (typeof b === 'number' && !eqP(b, rb)))
        opDiv = { at, id, a, b, ra, rb, ctx: ring.slice(0, -1) };
    }
    at++;
  }
  return r;
};
const OPS = !!process.env.OPERANDS,
  OPTOL = +(process.env.OPTOL || 1e-9);
let opv = OPS ? new Float64Array(1 << 21) : null,
  refOps = null,
  opDiv = null;

const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLoopBlinnCDT } = await import('../src/renderer/loopBlinn.js');
const { packLoopBlinnMesh } = await import('../src/renderer/lbPack.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { pathToCycles } = await import('../src/geom/cpatchGraph.js');
const { resolveSelfOverlap } = await import('../src/renderer/shapeResolve.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');
console.warn = () => {};

const [file, shapeArg, kArg, stage = 'lbShape'] = process.argv.slice(2);
const s = +shapeArg,
  S = 2 ** +kArg;
const svg = readFileSync(file, 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(svg, { preserveViewport: true });
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape),
  fps = meta.floatsPerShape,
  mf = meta.metaFloats,
  bb = s * fps;
const transSolid =
  mf[bb + 7] < 0.996 &&
  Math.floor(mf[bb + 28] + 0.5) === 0 &&
  (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0);
const evenOdd = mf[bb + 13] > 0.5;
const r = sec.curveRangesByShape[s];
const plane =
  stage === 'cpatch' || stage === 'graph'
    ? sec.curves64
      ? new Float64Array(sec.curves64)
      : new Float32Array(sec.curves)
    : new Float32Array(sec.curves);
const base = curveRangeToContours(plane, r.begin, r.end);
const scaled = (Sc) =>
  base.map((c) =>
    c.map((sg) => {
      const P = (q) => q && [q[0] * Sc, q[1] * Sc];
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        sg.circle ? { cx: sg.circle.cx * Sc, cy: sg.circle.cy * Sc, r: sg.circle.r * Sc } : null,
      );
    }),
  );
const RUN = {
  lbShape: (c) => {
    const b = buildLbShape(c, transSolid, evenOdd);
    return b ? b.pk.vertexCount : -1;
  },
  lbCdt: (c) => {
    const m = buildLoopBlinnCDT(c, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
    return packLoopBlinnMesh(m).vertexCount;
  },
  cpatch: (c) => {
    const w = packCPatchShape(contoursToConverter(c, null), 0, { evenOdd });
    return w ? w.texels.length : -1;
  },
  graph: (c) => {
    const cy = pathToCycles(contoursToConverter(c, null), evenOdd);
    return cy ? cy.length : -1;
  },
  resolve: (c) => {
    const o = resolveSelfOverlap(c, evenOdd ? 'evenodd' : 'nonzero');
    return o ? o.length : -1;
  },
}[stage];

const fmt = (v) =>
  typeof v === 'number'
    ? v.toExponential(6)
    : Array.isArray(v)
      ? '[array]'
      : String(v).slice(0, 40);
if (ROLE === 'rec' || ROLE === 'peek') {
  const c1 = scaled(1);
  mode = 'rec';
  const o1 = RUN(c1);
  mode = 'off';
  if (ROLE === 'rec') {
    writeFileSync(TMP + '.seq', Buffer.from(seq.buffer, 0, n * 4));
    writeFileSync(TMP + '.names', JSON.stringify(names));
    if (OPS) writeFileSync(TMP + '.ops', Buffer.from(opv.buffer, 0, n * 16));
    console.log(`result at 1 = ${o1}, ${n} comparisons`);
  } else if (peek) console.log(`  at 1 operands: ${fmt(peek.a)} vs ${fmt(peek.b)}`);
} else {
  const buf = readFileSync(TMP + '.seq');
  ref = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  refNames = JSON.parse(readFileSync(TMP + '.names', 'utf8'));
  if (OPS) {
    const ob = readFileSync(TMP + '.ops');
    refOps = new Float64Array(ob.buffer.slice(ob.byteOffset, ob.byteOffset + ob.byteLength));
  }
  const cS = scaled(S);
  mode = 'cmp';
  const oS = RUN(cS);
  mode = 'off';
  console.log(
    `${stage} ${file} #${s}: at 2^${kArg} = ${oS}; ${ref.length} comparisons at 1, ${at} replayed`,
  );
  if (opDiv)
    console.log(
      `FIRST NON-EQUIVARIANT OPERANDS at comparison #${opDiv.at}: ${opDiv.id}  2^${kArg}: (${opDiv.a}, ${opDiv.b})  at 1: (${opDiv.ra}, ${opDiv.rb})\n  preceding sites: ${opDiv.ctx.join(' ')}`,
    );
  if (!div) {
    console.log('no comparison differs');
  } else {
    console.log(`FIRST DIFFERENCE at comparison #${div.at}:`);
    console.log(`  at 1:     ${div.ref} -> ${div.refR}`);
    console.log(`  at 2^${kArg}: ${div.id} -> ${div.r}   (${fmt(div.a)} vs ${fmt(div.b)})`);
    console.log('  preceding sites: ' + div.ctx.join(' '));
  }
}
