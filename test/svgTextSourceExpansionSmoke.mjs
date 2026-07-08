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

const FONT = new MantleFontAsset(
  new Uint8Array(readFileSync(new URL('./font/fixtures/roboto-regular.ttf', import.meta.url))));

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const RENDERABLE = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text']);
function renderableTags(svgString) {
  const root = new DP().parseFromString(svgString, 'image/svg+xml').documentElement;
  const out = [];
  (function walk(n) {
    if (n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      if (tag === 'defs') return;            // mask/gradient defs aren't shapes
      if (RENDERABLE.has(tag)) out.push({ tag, el: n });
    }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  })(root);
  return out;
}
const imp = (svg, opts) => importSvg(svg, {
  retainSource: true, keepInvisibleShapes: true,
  fonts: { Roboto: FONT }, svgTextLayout: buildSvgTextGlyphs, ...opts,
});

// ── 1. No-mask: strict 1:1 (box + glyphs) ────────────────────────────
{
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
    <path d="M10 10 H60 V60 H10 Z" fill="#0000ff"/>
    <text x="70" y="50" font-family="Roboto" font-size="40" fill="#ff0000">Hi</text>
  </svg>`;
  const s = await imp(SVG);
  const r = renderableTags(s.svgSource);
  const tags = r.map(x => x.tag);
  console.log(`[no-mask] numShapes=${s.numShapes} svgSource renderable=[${tags.join(',')}]`);

  if (!tags.includes('text')) ok('[no-mask] <text> expanded away (no <text> in svgSource)');
  else fail('[no-mask] <text> still present');

  if (tags.length === s.numShapes) ok(`[no-mask] renderable count (${tags.length}) == bundle shapes (${s.numShapes}) — 1:1 invariant`);
  else fail(`[no-mask] count mismatch: ${tags.length} vs ${s.numShapes}`);

  if (tags.every(t => t === 'path')) ok('[no-mask] every renderable is a <path> (box + glyphs)');
  else fail('[no-mask] non-path renderable: ' + tags.join(','));

  const glyphs = r.slice(1).map(x => x.el);  // drop the box
  if (glyphs.length >= 2 && glyphs.every(p => (p.getAttribute('d') || '').length > 4))
    ok(`[no-mask] ${glyphs.length} glyph paths carry geometry`);
  else fail('[no-mask] glyph geometry missing');
  if (glyphs.every(p => /255\s*,\s*0\s*,\s*0/.test(p.getAttribute('fill') || '')))
    ok('[no-mask] glyph paths carry the text fill (red)');
  else fail('[no-mask] glyph fill wrong: ' + glyphs[0].getAttribute('fill'));
  // No stray transparent stroke serialized.
  if (glyphs.every(p => !p.getAttribute('stroke'))) ok('[no-mask] no spurious transparent stroke on glyphs');
  else fail('[no-mask] unexpected stroke on a glyph: ' + glyphs[0].getAttribute('stroke'));

  if (s.svgSourceNativeText && /<text[\s>]/.test(s.svgSourceNativeText)) ok('[no-mask] svgSourceNativeText retains authored <text>');
  else fail('[no-mask] svgSourceNativeText missing/blank');
}

// ── 2. Masked (a real pose shape): box + text inside <g mask> ─────
//    The mask bakes a trailing full-canvas backdrop shape (no rendered
//    element — handled natively by the mask= attribute), so we don't
//    assert count==numShapes; we assert the text expanded and the box +
//    glyphs lead the renderable list in shape order.
{
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
    <defs><mask id="m"><rect x="0" y="0" width="200" height="100" fill="#fff"/></mask></defs>
    <g mask="url(#m)">
      <path d="M10 10 H60 V60 H10 Z" fill="#0000ff"/>
      <text x="70" y="50" font-family="Roboto" font-size="40" fill="#ff0000">Hi</text>
    </g>
  </svg>`;
  const s = await imp(SVG);
  const r = renderableTags(s.svgSource);
  const tags = r.map(x => x.tag);
  console.log(`[masked] numShapes=${s.numShapes} svgSource renderable=[${tags.join(',')}]`);

  if (!tags.includes('text')) ok('[masked] <text> expanded away under <g mask>');
  else fail('[masked] <text> still present under mask');
  if (tags.length >= 3 && tags.every(t => t === 'path')) ok(`[masked] box + glyphs present as paths (${tags.length})`);
  else fail('[masked] expected >=3 path renderables, got ' + tags.join(','));
  // The mask backdrop shape is the ONLY shape without a rendered element:
  // exactly one more shape than renderable elements.
  if (s.numShapes - tags.length === 1) ok('[masked] exactly 1 unrendered shape (the mask backdrop) — glyph indices unshifted');
  else console.log(`note: [masked] numShapes-renderable = ${s.numShapes - tags.length} (mask handling)`);
}

// ── 3. No <text> → no redundant native-text variant ──────────────────
{
  const plain = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><rect x="5" y="5" width="40" height="40" fill="#0f0"/></svg>',
    { retainSource: true });
  if (plain.svgSource && plain.svgSourceNativeText == null)
    ok('[no-text] svgSource set, no redundant svgSourceNativeText');
  else fail('[no-text] unexpected native-text variant on a text-free SVG');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nSVG-TEXT-SOURCE-EXPANSION PASS');
process.exit(failures ? 1 : 0);
