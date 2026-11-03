// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// overrideTableContractSmoke — the override table's read-back, input and lifetime contract.
//
//   get() reports the SIGNED scale: set({localScale:[-1,1]}) reads back as that, not as rotation -pi, scale [1,1] (the matrix -I)
//   update({localRotation}) after a zero scale keeps the collapsed axis (it does not reset it to 1); NaN visibility and a
//          NaN / short tint are not stored raw (the GPU would read NaN)
//   clearClipper leaves the row not "overridden" (hasAny, activeIndices drop it); dispose() twice deletes the texture
//          once, and set / uploadIfDirty after dispose bind no deleted texture
//
// CPU only: the real override table on a counting GL wrapper over test/_fakeGl.mjs.
import { createFakeGl } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createOverrideTable } = await import('../src/index.js');

// A GL that reports double deletes and uses of a deleted object.
function countingGl() {
  const F = createFakeGl({ width: 64, height: 64 });
  const live = new Set(),
    deleted = new WeakSet(),
    problems = [];
  const gl = new Proxy(F.gl, {
    get(t, k) {
      const v = t[k];
      if (k === 'createTexture')
        return () => {
          const o = v.call(t);
          live.add(o);
          return o;
        };
      if (k === 'deleteTexture')
        return (o) => {
          if (o == null) return;
          if (!live.has(o)) problems.push('double delete');
          live.delete(o);
          deleted.add(o);
          return v.call(t, o);
        };
      if (k === 'bindTexture' || k === 'texSubImage2D' || k === 'texImage2D')
        return (...a) => {
          for (const x of a)
            if (x && typeof x === 'object' && deleted.has(x))
              problems.push('use after delete in ' + String(k));
          return v.apply(t, a);
        };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { gl, live, problems };
}

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const G = countingGl();
const b = createBundle(
  G.gl,
  await importSvg(
    svg(
      '<rect id="a" x="10" y="10" width="30" height="30" fill="red"/><circle id="b" cx="70" cy="70" r="20" fill="blue"/>',
    ),
  ),
);

console.log('signed read-back');
{
  const T = createOverrideTable(G.gl, b);
  const m = (k) => {
    const p = T.packedBuffer;
    return [p[k * 24], p[k * 24 + 1], p[k * 24 + 2], p[k * 24 + 3]];
  };
  const same = (a, c) => a.every((v, i) => near(v, c[i]));
  for (const [rot, sx, sy] of [
    [0, -1, 1],
    [0, 1, -1],
    [0, -2, 3],
    [0.5, -1, 1],
    [-0.7, 2, -0.5],
    [0.3, 1.5, 2],
    [Math.PI / 2, 1, 1],
    [0, -1, -1],
    [2.5, -1, 1],
  ]) {
    T.set('a', { localRotation: rot, localScale: [sx, sy] });
    const before = m(0),
      g = T.get('a');
    T.set('b', { localRotation: g.localRotation, localScale: g.localScale });
    ok(
      same(before, m(1)),
      `rot ${rot} scale [${sx}, ${sy}]: set(get()) reproduces the matrix (read back rot ${g.localRotation.toFixed(3)}, scale [${g.localScale.map((v) => +v.toFixed(3))}])`,
    );
  }
  T.set('a', { localScale: [-1, 1] });
  const g = T.get('a');
  ok(
    near(g.localRotation, 0) && near(g.localScale[0], -1) && near(g.localScale[1], 1),
    'a mirror [-1, 1] reads back as rotation 0, scale [-1, 1]',
  );
  T.update('a', { localRotation: 0.5 });
  const u = T.get('a');
  ok(
    near(u.localRotation, 0.5) && near(u.localScale[0], -1) && near(u.localScale[1], 1),
    'update({localRotation}) keeps the mirror',
  );
  T.dispose();
}

console.log('zero scale and input validation');
{
  const T = createOverrideTable(G.gl, b);
  T.set('a', { localScale: [0, 1] });
  T.update('a', { localRotation: 0.5 });
  let g = T.get('a');
  ok(
    near(g.localScale[0], 0) && near(g.localScale[1], 1, 1e-6) && near(g.localRotation, 0.5, 1e-6),
    `a zero x scale survives update({localRotation}) (got ${JSON.stringify(g.localScale)}, rot ${g.localRotation})`,
  );
  T.update('a', { localScale: [1, 0] });
  T.update('a', { localRotation: -0.25 });
  g = T.get('a');
  ok(
    near(g.localScale[0], 1, 1e-6) &&
      near(g.localScale[1], 0) &&
      near(g.localRotation, -0.25, 1e-6),
    'a zero y scale survives too',
  );
  T.update('a', { localScale: [0, 0] });
  T.update('a', { localRotation: 1 });
  ok(
    near(T.get('a').localScale[0], 0) && near(T.get('a').localScale[1], 0),
    'a fully collapsed scale stays collapsed',
  );

  const p = T.packedBuffer;
  const row = (i) => Array.from(p.slice(i * 24, i * 24 + 24));
  T.set('b', { visibility: NaN, tint: [1, 'x'] });
  let r = row(1);
  ok(r[6] === 1, 'set: NaN visibility reads as 1 (visible)');
  ok(
    r[8] === 1 && r[9] === 1 && r[10] === 1 && r[11] === 1,
    'set: a short / non-numeric tint component reads as 1',
  );
  T.set('b', { visibility: 3, tint: [0.5, 0.25, NaN, 2] });
  r = row(1);
  ok(
    r[6] === 1 && r[8] === 0.5 && r[9] === 0.25 && r[10] === 1 && r[11] === 2,
    'set: visibility clamps to 1; finite tint components are kept',
  );
  T.set('b', { localScale: [NaN, 2], localPosition: [NaN, 5], localRotation: NaN });
  r = row(1);
  ok(
    Number.isFinite(r[0] + r[1] + r[2] + r[3] + r[4] + r[5]) && r[5] === 5 && r[4] === 0,
    'set: non-finite scale / position / rotation components read as identity',
  );
  T.set('b', { visibility: 0.5, tint: [0.1, 0.2, 0.3, 0.4], localPosition: [3, 4] });
  T.update('b', { visibility: NaN, tint: [9, undefined, NaN], localPosition: [NaN, 7] });
  r = row(1);
  ok(r[6] === 0.5, 'update: NaN visibility keeps the current value');
  ok(
    near(r[8], 9) && near(r[9], 0.2) && near(r[10], 0.3) && near(r[11], 0.4),
    'update: a missing / NaN tint component keeps its current value',
  );
  ok(r[4] === 3 && r[5] === 7, 'update: a NaN position component keeps its current value');
  ok(
    Array.from(T.packedBuffer).every((v) => Number.isFinite(v)),
    'no NaN reaches the packed buffer',
  );
  T.dispose();
}

console.log('clipper flag and lifetime');
{
  const sec = await importSvg(
    svg(
      '<defs><clipPath id="c"><rect x="0" y="0" width="50" height="50"/></clipPath></defs><rect id="a" x="10" y="10" width="80" height="80" fill="red" clip-path="url(#c)"/>',
    ),
  );
  const b2 = createBundle(G.gl, sec);
  const T = createOverrideTable(G.gl, b2);
  ok(
    T.setClipper('c', { localPosition: [5, 5] }) === true &&
      T.hasAny === true &&
      T.activeIndices().length > 0,
    'setClipper marks the clip row overridden',
  );
  ok(T.clearClipper('c') === true, 'clearClipper resolves the clip');
  ok(
    T.hasAny === false && T.activeIndices().length === 0 && T.clippers.size === 0,
    'clearClipper releases the row: hasAny false, no active indices',
  );
  // another override on the same row survives the clearClipper
  T.setClipper('c', { localPosition: [5, 5] });
  const row = T.activeIndices()[0];
  T.update(row, { visibility: 0.5 });
  T.clearClipper('c');
  ok(
    T.activeIndices().includes(row),
    'a row that also carries a visibility override stays overridden after clearClipper',
  );
  T.dispose();
  b2.dispose();
}
{
  const g0 = countingGl();
  const bb = createBundle(
    g0.gl,
    await importSvg(svg('<rect id="a" x="10" y="10" width="30" height="30" fill="red"/>')),
  );
  const T = createOverrideTable(g0.gl, bb);
  const tex = T.texture;
  ok(tex != null, 'a live table exposes its texture');
  T.dispose();
  T.dispose();
  ok(
    g0.problems.length === 0,
    `dispose() twice deletes the texture once (${g0.problems.join('; ') || 'no problems'})`,
  );
  T.set('a', { visibility: 0 });
  T.uploadIfDirty();
  T.update('a', { localPosition: [1, 1] });
  T.uploadIfDirty();
  ok(
    g0.problems.length === 0,
    `set / update / uploadIfDirty after dispose bind and write no deleted texture (${g0.problems.join('; ') || 'no problems'})`,
  );
  ok(T.texture === null, 'a disposed table has no texture');
  ok(T.get('a').visibility === 0, 'the CPU side keeps working after dispose');
  bb.dispose();
}

console.log(fail ? `\nOVERRIDE-TABLE-CONTRACT FAIL (${fail})` : '\nOVERRIDE-TABLE-CONTRACT PASS');
process.exit(fail ? 1 : 0);
