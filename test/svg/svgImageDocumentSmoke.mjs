// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgImageDocumentSmoke.mjs — an <image> that references an SVG draws that document as an image:
// a separate document, placed and clipped in the image's viewport, composited as one picture.
//
// The importer splices the referenced document's shapes in, fitted by viewBox and preserveAspectRatio
// (nestedSvgImageSmoke), but not as if they were the referencing document's own:
//   - they do not INHERIT the referencing element's fill (a <g fill> around the image must not recolor it);
//   - they are CLIPPED, and the placement is SVG 2 §image's (natural aspect ratio, image-rendering rect,
//     both overflows), not the image's preserveAspectRatio over the viewBox alone, or Chrome's with
//     importSvg({ compat: 'chrome' }) (the root's preserveAspectRatio, the rect);
//   - the image's OPACITY reaches them (it is a group opacity on the whole picture);
//   - an image INSIDE the image is loaded, and a document that references itself through svgTextLoader
//     is guarded;
//   - a link inside the image is inert, as in a browser (only an <a> around the image counts).
//
// Asserts each on the importSvg sections (meta rows), no GL.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';
import { setDiagnostics } from '../../src/core/diagnostics.js';
import { CASES, PTS, cellSvg } from '../_svgImageFitCases.mjs';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

const b64 = (s) => 'data:image/svg+xml;base64,' + Buffer.from(s, 'utf8').toString('base64');
const doc = (body, attrs = 'viewBox="0 0 10 10"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const outer = (body) => doc(body, 'viewBox="0 0 100 60"');
const rowsOf = (b) => {
  if (!b.numShapes) return [];
  const m = new Float32Array(b.meta, 32),
    st = b.metaFloatsPerShape || 48,
    rows = [];
  for (let i = 0; i < b.numShapes; i++)
    rows.push({
      id: b.shapeIds[i],
      href: b.shapeHrefs[i],
      bbox: Array.from(m.subarray(i * st, i * st + 4)),
      fill: Array.from(m.subarray(i * st + 4, i * st + 8)),
      flags: Math.round(m[i * st + 27]),
      clipId: Math.round(m[i * st + 30]),
    });
  return rows;
};
const near = (a, b, tol = 1e-3) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fmt = (a) => '[' + a.map((v) => +v.toFixed(3)).join(', ') + ']';
// The bbox of the clip row a shape's clip names: clipperRows maps each clip's svgId to its layer rows.
const clipBoxes = (b) => {
  const rows = rowsOf(b),
    out = [];
  for (const [id, [f, l]] of Object.entries(b.clipperRows || {})) {
    if (!id.startsWith('__mantleViewportClip')) continue;
    for (let r = f; r <= l; r++) out.push(rows[r].bbox);
  }
  return out;
};

// ---- 1. No inheritance from the referencing document ----
{
  const img = b64(doc('<rect id="plain" width="10" height="10"/>'));
  const img2 = b64(
    doc('<rect id="rooted" width="10" height="10"/>', 'viewBox="0 0 10 10" fill="#00f"'),
  );
  const b = await importSvg(
    outer(
      `<g fill="#0f0" stroke="#f00"><image x="0" y="0" width="40" height="40" href="${img}"/>` +
        `<image x="50" y="0" width="40" height="40" href="${img2}"/></g>`,
    ),
    {},
  );
  const rows = rowsOf(b);
  const plain = rows.find((r) => r.id === 'plain'),
    rooted = rows.find((r) => r.id === 'rooted');
  if (plain && near(plain.fill, [0, 0, 0, 1]))
    ok(`an unstyled rect in an image is black, not the <g>'s green: fill ${fmt(plain.fill)}`);
  else
    fail(
      `an unstyled rect in an image inherited from the referencing <g>: fill ${plain ? fmt(plain.fill) : 'missing'}`,
    );
  if (rooted && near(rooted.fill, [0, 0, 1, 1]))
    ok(`the inner root's own fill="#00f" applies: fill ${fmt(rooted.fill)}`);
  else fail(`the inner root's fill: ${rooted ? fmt(rooted.fill) : 'missing'}, want blue`);
  if (!rows.some((r) => r.id === 'plain_stroke' || r.id === 'rooted_stroke'))
    ok('no stroke inherited from the <g>');
  else fail('a stroke row was inherited from the referencing <g stroke>');
}

// ---- 2. Placement and clip, both compat modes, over the probe cases ----
// test/_svgImageFitCases.mjs: each case imported alone, its colors read off the meta rows at the
// case's points (each painted row is an axis-aligned rect here; the last one covering a point, and
// inside the viewport clip when it has one, is the color there) and held to the case's spec row
// (default mode) and Chrome row (compat: 'chrome').
{
  const nameOf = (fill) => {
    const k = fill
      .slice(0, 3)
      .map((v) => (v > 0.8 ? 1 : v < 0.2 ? 0 : -1))
      .join('');
    return { 100: 'red', 110: 'yel', '010': 'grn', '001': 'blu', 111: 'wht' }[k] || fmt(fill);
  };
  const inBox = (bb, x, y) => x >= bb[0] && x < bb[2] && y >= bb[1] && y < bb[3];
  const colorsAt = (b, pts) => {
    const rows = rowsOf(b);
    const clipRow = new Set();
    for (const [f, l] of Object.values(b.clipperRows || {}))
      for (let r = f; r <= l; r++) clipRow.add(r);
    const vclip = clipBoxes(b);
    if (vclip.length > 1)
      throw new Error(`${vclip.length} viewport clip rows, expected at most one`);
    return pts.map(([px, py]) => {
      const x = px + 0.5,
        y = py + 0.5;
      let c = 'wht';
      rows.forEach((r, i) => {
        if (clipRow.has(i) || !inBox(r.bbox, x, y)) return;
        if (r.clipId > 0) {
          if (!vclip.length)
            throw new Error(`row ${i} names clip ${r.clipId} but no viewport clip row exists`);
          if (!inBox(vclip[0], x, y)) return;
        }
        c = nameOf(r.fill);
      });
      return c;
    });
  };
  for (const mode of ['spec', 'chrome']) {
    let bad = 0;
    for (const c of CASES) {
      const b = await importSvg(cellSvg(c), mode === 'spec' ? {} : { compat: 'chrome' });
      let got;
      try {
        got = colorsAt(b, PTS);
      } catch (e) {
        fail(`${mode} case ${c.id} (${c.what}): ${e.message}`);
        bad++;
        continue;
      }
      const want = c[mode];
      const off = PTS.map((p, i) =>
        got[i] === want[i] ? null : `(${p}) ${got[i]} want ${want[i]}`,
      ).filter(Boolean);
      if (off.length) {
        fail(`${mode} case ${c.id} (${c.what}): ${off.join(', ')}`);
        bad++;
      }
    }
    const diverge = CASES.reduce(
      (n, c) => n + c.spec.filter((v, i) => v !== c.chrome[i]).length,
      0,
    );
    if (!bad)
      ok(
        `compat '${mode}': all ${CASES.length} cases x ${PTS.length} points match the ${mode === 'spec' ? 'spec' : 'Chrome'} rows` +
          (mode === 'chrome'
            ? ` (${diverge} of the points are Chrome departing from the spec)`
            : ''),
      );
  }
  // An unknown mode warns and falls back to the spec -- and so does the per-feature option `compat` replaced.
  for (const [opts, re] of [
    [{ compat: 'firefox' }, /compat "firefox"/],
    [{ svgImageFit: 'chrome' }, /svgImageFit option is gone/],
  ]) {
    const warns = [];
    setDiagnostics({ onWarn: (m) => warns.push(String(m)) });
    const u = await importSvg(cellSvg(CASES[1]), opts);
    setDiagnostics({ onWarn: null });
    const gotU = colorsAt(u, PTS).join(' ');
    if (warns.some((w) => re.test(w)) && gotU === CASES[1].spec.join(' '))
      ok(`${JSON.stringify(opts)} warns and places per the spec`);
    else fail(`${JSON.stringify(opts)}: warns ${JSON.stringify(warns)}, colors ${gotU}`);
  }
}

// ---- 3. The image's opacity is ONE group over its content ----
{
  const img = b64(
    doc(
      '<rect id="a" width="6" height="6" fill="red"/><rect id="b" x="4" y="4" width="6" height="6" fill="blue"/>',
    ),
  );
  const b = await importSvg(
    outer(`<image x="0" y="0" width="40" height="40" opacity="0.5" href="${img}"/>`),
    {},
  );
  const rows = rowsOf(b);
  const begin = rows.findIndex((r) => (r.flags & 64) !== 0),
    end = rows.findIndex((r) => (r.flags & 128) !== 0);
  const ia = rows.findIndex((r) => r.id === 'a'),
    ib = rows.findIndex((r) => r.id === 'b');
  if (
    begin >= 0 &&
    end > begin &&
    ia > begin &&
    ib > ia &&
    end > ib &&
    Math.abs(rows[begin].fill[3] - 0.5) < 1e-6 &&
    near(rows[ia].fill, [1, 0, 0, 1])
  )
    ok(`opacity 0.5 is a group [${begin}..${end}] around both shapes, which stay opaque inside it`);
  else
    fail(
      `opacity: group rows ${begin}..${end}, shapes at ${ia}, ${ib}, group opacity ${begin >= 0 ? rows[begin].fill[3] : '-'}`,
    );
}

// ---- 4. An image inside an image; a cycle through svgTextLoader is cut ----
{
  const inner = b64(doc('<rect id="deep" width="10" height="10" fill="green"/>'));
  const mid = b64(
    doc(
      `<rect id="mid" width="5" height="10"/><image x="5" y="0" width="5" height="10" href="${inner}"/>`,
    ),
  );
  const b = await importSvg(outer(`<image x="0" y="0" width="40" height="40" href="${mid}"/>`), {});
  if (b.shapeIds.includes('mid') && b.shapeIds.includes('deep'))
    ok('an SVG image inside an SVG image draws');
  else fail(`nested image: shapeIds ${JSON.stringify(b.shapeIds)}`);

  const files = {
    'a.svg': doc(
      '<rect id="inA" width="10" height="10"/><image width="10" height="10" href="b.svg"/>',
    ),
    'b.svg': doc(
      '<rect id="inB" width="10" height="10"/><image width="10" height="10" href="a.svg"/>',
    ),
    'self.svg': doc(
      '<rect id="inSelf" width="10" height="10"/><image width="10" height="10" href="self.svg"/>',
    ),
  };
  const calls = [];
  const warns = [];
  setDiagnostics({ onWarn: (m) => warns.push(String(m)) });
  const c = await importSvg(
    outer(
      '<image width="40" height="40" href="a.svg"/><image x="50" width="40" height="40" href="self.svg"/>',
    ),
    {
      svgTextLoader: async (h) => {
        calls.push(h);
        return files[h] || null;
      },
    },
  );
  setDiagnostics({ onWarn: null });
  const count = (id) => c.shapeIds.filter((x) => x === id).length;
  if (
    count('inA') === 1 &&
    count('inB') === 1 &&
    count('inSelf') === 1 &&
    warns.some((w) => /references a document it is inside/.test(w))
  )
    ok(
      `a -> b -> a and self -> self are cut after one level each (loader calls ${calls.join(', ')}), with a warning`,
    );
  else
    fail(
      `cycle: inA x${count('inA')}, inB x${count('inB')}, inSelf x${count('inSelf')}, loader calls ${calls.join(', ')}, warns ${JSON.stringify(warns)}`,
    );
}

// ---- 5. Links inside the image are inert; an <a> around the image is the link ----
{
  const img = b64(doc('<a href="inner.html"><rect id="linked" width="10" height="10"/></a>'));
  const b = await importSvg(
    outer(
      `<a href="outer.html"><image width="40" height="40" href="${img}"/></a>` +
        `<image x="50" width="40" height="40" href="${img}"/>`,
    ),
    {},
  );
  const hs = b.shapeIds
    .map((id, i) => (id === 'linked' ? b.shapeHrefs[i] : null))
    .filter((h) => h !== null);
  if (hs.length === 2 && hs[0] === 'outer.html' && hs[1] === '')
    ok(`hrefs of the image's linked rect: ${JSON.stringify(hs)} (outer link, then none)`);
  else fail(`inner links: ${JSON.stringify(hs)}, want ["outer.html", ""]`);
}

// ---- 6. A document with no intrinsic size is laid out unscaled in the image's viewport ----
{
  const img = b64(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect id="u" x="2" y="3" width="10" height="10"/></svg>',
  );
  const b = await importSvg(
    outer(`<image x="20" y="10" width="30" height="30" href="${img}"/>`),
    {},
  );
  const u = rowsOf(b).find((r) => r.id === 'u');
  if (u && near(u.bbox, [22, 13, 32, 23]))
    ok(`no viewBox or size: drawn at the image origin, unscaled ${fmt(u.bbox)}`);
  else fail(`no intrinsic size: ${u ? fmt(u.bbox) : 'nothing drawn'}, want [22, 13, 32, 23]`);
}

if (failures) {
  console.error(`\nSVG-IMAGE-DOCUMENT FAIL (${failures})`);
  process.exit(1);
}
console.log('\nSVG-IMAGE-DOCUMENT PASS');
