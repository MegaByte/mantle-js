// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMeshIdentity.mjs — byte identity of every Loop-Blinn mesh a tree builds, for switch deletions.
//
// Deleting an ESCAPE switch (default on, setting it restores older behavior) removes the branch the
// default never takes, so every mesh must come out byte-identical; deleting a LOST off-arm the same.
// This builds every shape of a corpus through one tree's modules and hashes what it produced, so two
// trees (a baseline and a branch) can be compared shape for shape:
//
//   import  importSvg's whole output per file (curves, bands, meta, meshes ...), since a switch in the
//           path-boolean code the importer shares can move a bundle without touching a mesh.
//   static  buildLbBundle -- the entry the build worker and the main thread's _ensureLbMeshes share --
//           once with the SDF primitive recognisers on (the default) and once with them off, so rings
//           and discs reach the partition too. Per shape: the packed stream (every field, every typed
//           array's bytes), the raw CPU mesh, and the SLUG_WHY verdict, declines included.
//   morph   buildMorphShape -- the per-shape body of the worker's morph build (earcut pair, partition
//           pair, t-segmented flip pairs) -- over every matched shape of the examples/smoke
//           *__SRC.svg / *__DST.svg pairs, and over synthetic pairs made from the static corpus: each
//           small curved shape against a similarity of itself and against a smooth non-affine warp
//           of itself (a function of position, so shared joints stay shared), which is what reaches
//           the classification-flip segmenter.
//
//   node probes/flags/lbMeshIdentity.mjs run <tree js.kontek.mantle dir> <out.json> [corpus dir ...]
//   node probes/flags/lbMeshIdentity.mjs compare <a.json> <b.json>
//
// LB_FLAGS='{"__LB_HULL_CONTAIN":false}' sets globals before anything builds. Run against the BASELINE
// with a switch set, it shows the harness reaches that switch's branch at all -- an identity result
// is only worth something for a switch the corpus can see.
//
// Pass the same corpus directories to both runs (they default to this tree's own examples/smoke and
// MantleSamples/Assets/Mantle), so the inputs are the same bytes whichever tree is being built.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';

const [mode, ...args] = process.argv.slice(2);

function feed(h, v, seen) {
  if (v === null) {
    h.update('N;');
    return;
  }
  if (v === undefined) {
    h.update('U;');
    return;
  }
  const t = typeof v;
  if (t === 'number') {
    h.update('n' + (Object.is(v, -0) ? '-0' : String(v)) + ';');
    return;
  }
  if (t === 'boolean' || t === 'string' || t === 'bigint') {
    h.update(t[0] + String(v) + ';');
    return;
  }
  if (t === 'function' || t === 'symbol') {
    h.update('F;');
    return;
  }
  if (ArrayBuffer.isView(v)) {
    h.update(v.constructor.name + ':' + v.byteLength + ':');
    h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    return;
  }
  if (v instanceof ArrayBuffer) {
    h.update('AB:' + v.byteLength + ':');
    h.update(Buffer.from(v));
    return;
  }
  // A back-reference by first-visit order: two trees that share a reference in one place and copy it
  // in the other hash differently, which is stricter than value equality and deterministic.
  if (seen.has(v)) {
    h.update('@' + seen.get(v) + ';');
    return;
  }
  seen.set(v, seen.size);
  if (Array.isArray(v)) {
    h.update('[' + v.length + ':');
    for (const e of v) feed(h, e, seen);
    h.update(']');
    return;
  }
  if (v instanceof Map) {
    h.update('M' + v.size + ':');
    for (const [k, e] of v) {
      feed(h, k, seen);
      feed(h, e, seen);
    }
    return;
  }
  if (v instanceof Set) {
    h.update('S' + v.size + ':');
    for (const e of v) feed(h, e, seen);
    return;
  }
  h.update('{');
  for (const k of Object.keys(v).sort()) {
    h.update(k + '=');
    feed(h, v[k], seen);
  }
  h.update('}');
}
const hashOf = (v) => {
  const h = createHash('sha1');
  feed(h, v, new Map());
  return h.digest('hex').slice(0, 20);
};

async function run(tree, out, corpusDirs) {
  if (process.env.LB_FLAGS) Object.assign(globalThis, JSON.parse(process.env.LB_FLAGS));
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const T = (p) => import(pathToFileURL(path.join(tree, p)).href);
  const { default: importSvg } = await T('src/svg/importer.js');
  const { parseMetaBin } = await T('src/renderer/bundle.js');
  const { buildLbBundle } = await T('src/renderer/lbBuildCore.js');
  const { setSdfPrimitivesEnabled } = await T('src/geom/shapeRecognize.js');
  const { buildMorphShape } = await T('src/renderer/lbMorphCore.js');
  const { curveRangeToContours } = await T('src/geom/lbContour.js');
  const { buildMorphPlan } = await T('src/core/morphCore.js');

  const repo = path.resolve(tree, '..');
  if (!corpusDirs.length)
    corpusDirs = [
      path.join(tree, 'examples/smoke'),
      path.join(repo, 'MantleSamples/Assets/Mantle'),
    ];
  const files = [];
  for (const d of corpusDirs) {
    if (!existsSync(d)) {
      console.error(`missing corpus dir ${d}`);
      process.exit(2);
    }
    for (const f of readdirSync(d)
      .filter((n) => n.endsWith('.svg'))
      .sort())
      files.push(path.join(d, f));
  }
  const rel = (f) => path.relative(repo, f).split(path.sep).slice(-3).join('/');
  const result = { tree, files: files.map(rel), imports: {}, static: {}, morph: {}, synth: {} };
  const t0 = Date.now();
  const imported = new Map();
  const load = async (f) => {
    if (imported.has(f)) return imported.get(f);
    let b = null,
      err = null;
    try {
      b = await importSvg(readFileSync(f, 'utf8'));
    } catch (ex) {
      err = String((ex && ex.message) || ex);
    }
    const r = { b, err };
    imported.set(f, r);
    return r;
  };
  const inputOf = (b) => {
    const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
    return {
      curveFloats: new Float32Array(b.curves),
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: b.curveRangesByShape,
      numShapes: b.numShapes,
    };
  };

  // ── static ──────────────────────────────────────────────────────────────────────────────────
  for (const [cfg, prims] of [
    ['prims', true],
    ['noprims', false],
  ]) {
    setSdfPrimitivesEnabled(prims);
    for (let i = 0; i < files.length; i++) {
      const f = files[i],
        key = cfg + ':' + rel(f);
      const { b, err } = await load(f);
      if (cfg === 'prims') result.imports[rel(f)] = b ? hashOf(b) : 'err:' + err;
      if (!b) {
        result.static[key] = { err };
        continue;
      }
      let res = null,
        berr = null;
      const tf = Date.now();
      try {
        res = buildLbBundle(inputOf(b));
      } catch (ex) {
        berr = String((ex && ex.stack) || ex);
      }
      if (!res) {
        result.static[key] = { err: berr };
        continue;
      }
      const shapes = [];
      for (let s = 0; s < b.numShapes; s++) {
        const pk = res.packed[s];
        shapes.push({
          why: res.why ? res.why[s] : -1,
          slug: !!(pk && pk.slug),
          p: hashOf(pk),
          r: hashOf(res.raw[s]),
        });
      }
      result.static[key] = {
        n: b.numShapes,
        bundle: hashOf({
          hasReal: res.hasReal,
          hasSlug: res.hasSlug,
          overBudget: res.overBudget,
          memWants: res.memWants,
        }),
        shapes,
      };
      const ms = Date.now() - tf;
      if (ms > 2000) console.error(`  slow ${key}: ${ms} ms`);
    }
    console.error(
      `static ${cfg}: ${files.length} files, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
  }
  setSdfPrimitivesEnabled(true);

  // ── morph fixtures ──────────────────────────────────────────────────────────────────────────
  const pairKey = (sc, dc, meta, dmeta, bb, st) => {
    let m = null,
      err = null;
    try {
      m = buildMorphShape(sc, dc, meta, dmeta, bb, st);
    } catch (ex) {
      err = String((ex && ex.message) || ex);
    }
    return err
      ? { err }
      : {
          h: hashOf(m),
          kind:
            m && m.fill === false
              ? 'nofill'
              : m && m.mesh
                ? m.mesh.segments
                  ? 'seg' + m.mesh.segments.length
                  : 'pair'
                : 'slug',
        };
  };
  for (const f of files.filter((n) => /__SRC\.svg$/.test(n))) {
    const g = f.replace(/__SRC\.svg$/, '__DST.svg');
    if (!existsSync(g)) continue;
    const A = await load(f),
      B = await load(g),
      key = rel(f);
    if (!A.b || !B.b) {
      result.morph[key] = { err: A.err || B.err };
      continue;
    }
    const a = A.b,
      d = B.b;
    const plan = buildMorphPlan(a, d);
    const ia = inputOf(a),
      id = inputOf(d),
      st = ia.metaFloatsPerShape;
    const cfa = ia.curveFloats,
      cfd = id.curveFloats;
    const out = [];
    for (const m of plan.matched) {
      const sc = curveRangeToContours(cfa, m.srcBegin, m.srcEnd);
      const dc = curveRangeToContours(cfd, m.dstBegin, m.dstEnd);
      if (!sc || !dc) {
        out.push({ src: m.srcIdx, skip: 'contours' });
        continue;
      }
      // The worker's merged plane keeps SRC's rows; dst's row for this shape sits in the same slot.
      const dmeta = new Float32Array(ia.metaFloats);
      dmeta.set(id.metaFloats.subarray(m.dstIdx * st, m.dstIdx * st + st), m.srcIdx * st);
      out.push({ src: m.srcIdx, ...pairKey(sc, dc, ia.metaFloats, dmeta, m.srcIdx * st, st) });
    }
    result.morph[key] = out;
  }
  console.error(
    `morph fixtures: ${Object.keys(result.morph).length} pairs, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );

  // ── synthetic pairs ─────────────────────────────────────────────────────────────────────────
  const MAX_SEGS = 40,
    PER_FILE = 3;
  const mapC = (ct, fn) =>
    ct.map((c) =>
      c.map((sg) => {
        const o = { ...sg };
        for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = fn(sg[k]);
        return o;
      }),
    );
  for (const f of files) {
    const { b } = await load(f);
    if (!b) continue;
    const ia = inputOf(b),
      st = ia.metaFloatsPerShape;
    const out = [];
    let taken = 0;
    for (let s = 0; s < b.numShapes && taken < PER_FILE; s++) {
      const r = b.curveRangesByShape[s];
      if (!r || r.end <= r.begin) continue;
      let sc = null;
      try {
        sc = curveRangeToContours(ia.curveFloats, r.begin, r.end);
      } catch {
        sc = null;
      }
      if (!sc || !sc.length) continue;
      const segs = sc.flat();
      if (segs.length > MAX_SEGS || !segs.some((g) => g.p3)) continue; // curved and small
      taken++;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const g of segs)
        for (const k of ['p1', 'p2', 'p3', 'p4'])
          if (g[k]) {
            x0 = Math.min(x0, g[k][0]);
            x1 = Math.max(x1, g[k][0]);
            y0 = Math.min(y0, g[k][1]);
            y1 = Math.max(y1, g[k][1]);
          }
      const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2,
        E = Math.max(x1 - x0, y1 - y0) || 1;
      const ca = Math.cos(0.12),
        sa = Math.sin(0.12),
        k = 1.13;
      const sim = mapC(sc, (p) => [
        cx + k * (ca * (p[0] - cx) - sa * (p[1] - cy)) + 0.07 * E,
        cy + k * (sa * (p[0] - cx) + ca * (p[1] - cy)) - 0.05 * E,
      ]);
      const warp = mapC(sc, (p) => [
        p[0] + 0.06 * E * Math.sin((5.1 * (p[1] - y0)) / E + 0.3),
        p[1] + 0.06 * E * Math.cos((4.3 * (p[0] - x0)) / E + 1.1),
      ]);
      out.push({
        s,
        sim: pairKey(sc, sim, ia.metaFloats, ia.metaFloats, s * st, st),
        warp: pairKey(sc, warp, ia.metaFloats, ia.metaFloats, s * st, st),
      });
    }
    if (out.length) result.synth[rel(f)] = out;
  }
  console.error(
    `synthetic pairs: ${Object.values(result.synth).reduce((a, v) => a + v.length, 0)} shapes, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  writeFileSync(out, JSON.stringify(result));
}

function compare(aPath, bPath) {
  const A = JSON.parse(readFileSync(aPath, 'utf8')),
    B = JSON.parse(readFileSync(bPath, 'utf8'));
  const diffs = [];
  let files = 0,
    shapes = 0,
    raws = 0,
    declines = 0,
    imports = 0;
  for (const key of new Set([...Object.keys(A.imports || {}), ...Object.keys(B.imports || {})])) {
    imports++;
    if ((A.imports || {})[key] !== (B.imports || {})[key])
      diffs.push(`import ${key}: importSvg output differs`);
  }
  for (const key of new Set([...Object.keys(A.static), ...Object.keys(B.static)])) {
    const a = A.static[key],
      b = B.static[key];
    files++;
    if (!a || !b) {
      diffs.push(`${key}: present in one run only`);
      continue;
    }
    if (a.err || b.err) {
      if (a.err !== b.err) diffs.push(`${key}: error ${a.err} / ${b.err}`);
      continue;
    }
    if (a.bundle !== b.bundle) diffs.push(`${key}: bundle-level result differs`);
    if (a.n !== b.n) {
      diffs.push(`${key}: ${a.n} vs ${b.n} shapes`);
      continue;
    }
    for (let s = 0; s < a.n; s++) {
      const x = a.shapes[s],
        y = b.shapes[s];
      shapes++;
      if (x.slug) declines++;
      if (x.p !== y.p || x.why !== y.why)
        diffs.push(
          `${key} #${s}: packed ${x.p === y.p ? 'same' : 'DIFFERS'}, why ${x.why}/${y.why}`,
        );
      else if (x.r !== y.r) {
        raws++;
        diffs.push(`${key} #${s}: raw CPU mesh differs (packed identical)`);
      }
    }
  }
  let pairs = 0,
    pairFiles = 0;
  for (const key of new Set([...Object.keys(A.morph), ...Object.keys(B.morph)])) {
    pairFiles++;
    const a = A.morph[key],
      b = B.morph[key];
    if (JSON.stringify(a && a.err) !== JSON.stringify(b && b.err)) {
      diffs.push(`morph ${key}: error differs`);
      continue;
    }
    if (!Array.isArray(a)) continue;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      pairs++;
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i]))
        diffs.push(
          `morph ${key} src#${a[i] && a[i].src}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`,
        );
    }
  }
  let synth = 0;
  const kinds = {};
  for (const key of new Set([...Object.keys(A.synth), ...Object.keys(B.synth)])) {
    const a = A.synth[key] || [],
      b = B.synth[key] || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      synth += 2;
      for (const w of ['sim', 'warp'])
        if (a[i]) kinds[a[i][w].kind || 'err'] = (kinds[a[i][w].kind || 'err'] || 0) + 1;
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i]))
        diffs.push(
          `synth ${key} #${a[i] && a[i].s}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`,
        );
    }
  }
  const segKinds = Object.entries(kinds)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  console.log(`imports: ${imports} files hashed whole`);
  console.log(
    `static: ${shapes} shapes over ${files} file-configs (${A.files.length} files x prims on/off), ${declines} Slug verdicts in A`,
  );
  console.log(
    `morph fixtures: ${pairs} matched shapes over ${pairFiles} pairs; synthetic: ${synth} pairs (${segKinds})`,
  );
  console.log(`${diffs.length} differ${raws ? ` (${raws} raw-only)` : ''}`);
  for (const d of diffs.slice(0, 60)) console.log('  ' + d);
  process.exit(diffs.length ? 1 : 0);
}

if (mode === 'run')
  await run(
    path.resolve(args[0]),
    path.resolve(args[1]),
    args.slice(2).map((d) => path.resolve(d)),
  );
else if (mode === 'compare') compare(args[0], args[1]);
else {
  console.error(
    'usage: lbMeshIdentity.mjs run <tree> <out.json> [corpus...] | compare <a.json> <b.json>',
  );
  process.exit(2);
}
