// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgTextSourceExpansionSmoke.mjs — proves retainSource expands <text>
// into real glyph <path>s so the native-SVG fallback's positional
// shape→element addressing lines up with the bundle's shape list.
//
// A <text> is ONE source element but the importer expands it to N
// glyph shapes; if svgSource kept the raw <text>, the native fallback
// would see 1 element where the bundle has N shapes and every later
// shape would misaddress. So the glyphs are baked as <path>s into
// svgSource (default) while the authored <text> is kept as
// svgSourceNativeText (for the nativeText render mode).
//
// Pure Node (xmldom) — no browser needed; it inspects the produced
// svgSource structure, which is the invariant the fallback relies on.

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

import importSvg from '../src/svg/importer.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';
import { fontFixture, readAsset } from './_assets.mjs';

const FONT = new MantleFontAsset(new Uint8Array(readAsset(fontFixture('roboto-regular.ttf'))));

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const RENDERABLE = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'line',
  'text',
]);
function renderableTags(svgString) {
  const root = new DP().parseFromString(svgString, 'image/svg+xml').documentElement;
  const out = [];
  (function walk(n) {
    if (n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      if (tag === 'defs') return; // mask/gradient defs aren't shapes
      if (RENDERABLE.has(tag)) out.push({ tag, el: n });
    }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  })(root);
  return out;
}
const imp = (svg, opts) =>
  importSvg(svg, {
    retainSource: true,
    keepInvisibleShapes: true,
    fonts: { Roboto: FONT },
    svgTextLayout: buildSvgTextGlyphs,
    ...opts,
  });

// ── 1. No-mask: strict 1:1 (box + glyphs) ────────────────────────────
{
  const SVG = readFileSync(
    new URL('../examples/smoke/svgTextSourceExpansion__SVG.svg', import.meta.url),
    'utf8',
  );
  const s = await imp(SVG);
  const r = renderableTags(s.svgSource);
  const tags = r.map((x) => x.tag);
  console.log(`[no-mask] numShapes=${s.numShapes} svgSource renderable=[${tags.join(',')}]`);

  if (!tags.includes('text')) ok('[no-mask] <text> expanded away (no <text> in svgSource)');
  else fail('[no-mask] <text> still present');

  if (tags.length === s.numShapes)
    ok(
      `[no-mask] renderable count (${tags.length}) == bundle shapes (${s.numShapes}) — 1:1 invariant`,
    );
  else fail(`[no-mask] count mismatch: ${tags.length} vs ${s.numShapes}`);

  if (tags.every((t) => t === 'path')) ok('[no-mask] every renderable is a <path> (box + glyphs)');
  else fail('[no-mask] non-path renderable: ' + tags.join(','));

  const glyphs = r.slice(1).map((x) => x.el); // drop the box
  if (glyphs.length >= 2 && glyphs.every((p) => (p.getAttribute('d') || '').length > 4))
    ok(`[no-mask] ${glyphs.length} glyph paths carry geometry`);
  else fail('[no-mask] glyph geometry missing');
  if (glyphs.every((p) => /255\s*,\s*0\s*,\s*0/.test(p.getAttribute('fill') || '')))
    ok('[no-mask] glyph paths carry the text fill (red)');
  else fail('[no-mask] glyph fill wrong: ' + glyphs[0].getAttribute('fill'));
  // No stray transparent stroke serialized.
  if (glyphs.every((p) => !p.getAttribute('stroke')))
    ok('[no-mask] no spurious transparent stroke on glyphs');
  else fail('[no-mask] unexpected stroke on a glyph: ' + glyphs[0].getAttribute('stroke'));

  if (s.svgSourceNativeText && /<text[\s>]/.test(s.svgSourceNativeText))
    ok('[no-mask] svgSourceNativeText retains authored <text>');
  else fail('[no-mask] svgSourceNativeText missing/blank');
}

// ── 2. Masked (a real pose shape): box + text inside <g mask> ─────
//    The mask bakes a trailing full-canvas backdrop shape (no rendered
//    element — handled natively by the mask= attribute), so we don't
//    assert count==numShapes; we assert the text expanded and the box +
//    glyphs lead the renderable list in shape order.
{
  const SVG = readFileSync(
    new URL('../examples/smoke/svgTextSourceExpansion__SVG2.svg', import.meta.url),
    'utf8',
  );
  const s = await imp(SVG);
  const r = renderableTags(s.svgSource);
  const tags = r.map((x) => x.tag);
  console.log(`[masked] numShapes=${s.numShapes} svgSource renderable=[${tags.join(',')}]`);

  if (!tags.includes('text')) ok('[masked] <text> expanded away under <g mask>');
  else fail('[masked] <text> still present under mask');
  if (tags.length >= 3 && tags.every((t) => t === 'path'))
    ok(`[masked] box + glyphs present as paths (${tags.length})`);
  else fail('[masked] expected >=3 path renderables, got ' + tags.join(','));
  // The mask backdrop shape is the only shape without a rendered element:
  // exactly one more shape than renderable elements.
  if (s.numShapes - tags.length === 1)
    ok('[masked] exactly 1 unrendered shape (the mask backdrop) — glyph indices unshifted');
  else
    console.log(
      `note: [masked] numShapes-renderable = ${s.numShapes - tags.length} (mask handling)`,
    );
}

// ── 3. No <text> → no redundant native-text variant ──────────────────
{
  const plain = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><rect x="5" y="5" width="40" height="40" fill="#0f0"/></svg>',
    { retainSource: true },
  );
  if (plain.svgSource && plain.svgSourceNativeText == null)
    ok('[no-text] svgSource set, no redundant svgSourceNativeText');
  else fail('[no-text] unexpected native-text variant on a text-free SVG');
}

// Reimporting expanded glyph paths must preserve the authored affine stroke.
for (const [outer, own] of [
  ['', 'scale(2 1)'],
  ['translate(7 3) rotate(15)', 'scale(1.5 .7)'],
  ['matrix(1 .2 .3 1 4 5)', 'scale(-1 1)'],
  ['', 'scale(2 0)'],
  ['', 'scale(2 .00000001)'],
]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g transform="${outer}"><text x="8" y="32" font-family="Roboto" font-size="24" fill="none" stroke="red" stroke-width="2" transform="${own}">A</text></g></svg>`;
  const original = await imp(svg, { preserveViewport: true });
  const expanded = await importSvg(original.svgSource, {
    preserveViewport: true,
    keepInvisibleShapes: true,
  });
  const a = new Float32Array(original.meta, 32),
    b = new Float32Array(expanded.meta, 32);
  const stride = original.numShapes ? a.length / original.numShapes : 0;
  const slots = [0, 1, 2, 3, 11, 12, 20, 21, 22, 23];
  const same =
    original.numShapes === expanded.numShapes &&
    a.length === b.length &&
    Array.from({ length: original.numShapes }, (_, row) =>
      slots.every((slot) => {
        const i = row * stride + slot;
        return Math.abs(a[i] - b[i]) <= 2e-6 * Math.max(1, Math.abs(a[i]), Math.abs(b[i]));
      }),
    ).every(Boolean);
  if (same) ok('expanded glyphs preserve geometry and stroke metric: ' + outer + ' / ' + own);
  else fail('expanded glyph geometry or stroke metric differs: ' + outer + ' / ' + own);
}

{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g stroke-dasharray="8 4" stroke-dashoffset="-3"><text x="8" y="32" font-family="Roboto" font-size="24" fill="none" stroke="red" stroke-width="2" transform="scale(2 1)" vector-effect="non-scaling-stroke">A</text></g></svg>';
  const original = await imp(svg, { preserveViewport: true }),
    expanded = await importSvg(original.svgSource, {
      preserveViewport: true,
      keepInvisibleShapes: true,
    });
  const a = new Float32Array(original.meta, 32),
    b = new Float32Array(expanded.meta, 32),
    da = new Float32Array(original.dashes),
    db = new Float32Array(expanded.dashes);
  let same =
    original.numShapes === expanded.numShapes && a.length === b.length && da.length === db.length;
  for (let row = 0; row < original.numShapes; row++)
    for (const slot of [12, 20, 21, 22, 23, 27])
      if (a[row * 48 + slot] !== b[row * 48 + slot]) same = false;
  if (same && Array.from(da).every((v, i) => v === db[i]) && da[0] === 12 && da[2] === -3)
    ok('expanded non-scaling glyphs preserve host dashes and flags');
  else fail('expanded non-scaling glyphs changed stroke metrics');
}

// Source expansion and section cloning preserve each hidden glyph's hit owner.
{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><text id="letters" x="2" y="24" font-family="Roboto" font-size="20" visibility="hidden" pointer-events="painted">HHH</text></svg>';
  const s = await imp(svg, { keepHidden: true, keepInvisibleShapes: false });
  const copy = structuredClone(s),
    owners = copy.hitOnly?.hiddenOwner;
  const mapped = owners ? Array.from(owners).filter((r) => r >= 0) : [];
  if (
    mapped.length >= 3 &&
    new Set(mapped).size >= 3 &&
    !copy.svgSource.includes('<text') &&
    mapped.every((r) => r < copy.numShapes && copy.hitBits[r] & 128) &&
    !Object.keys(copy).some((k) => k.startsWith('_hit'))
  )
    ok('cloned expanded text keeps distinct glyph owners without private pass fields');
  else fail('cloned expanded text lost or conflated hidden glyph owners');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nSVG-TEXT-SOURCE-EXPANSION PASS');
process.exit(failures ? 1 : 0);
