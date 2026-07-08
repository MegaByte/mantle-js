// imageMaskInheritanceSmoke.mjs — verifies an <image> inherits its
// mask / clip-path from the ancestor <g> stack (resolve own style →
// own attr → ancestor stack via currentMaskRef() / currentClipRef()),
// and a bare <image> picks up no phantom mask/clip.
//
// preloadImages requires an Image() + canvas getImageData path to
// resolve raster bitmaps; xmldom has neither. We stub a minimal
// Image / document.createElement('canvas') pair that fabricates a
// solid-red 10×10 RGBA8 buffer so the importer's <image> branch
// actually fires (the imageDataMap entry exists, claimImage returns
// non-zero, the leaf enqueues a shape we can inspect).
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
function stubImageIO() {
  const W = 10, H = 10;
  globalThis.Image = class FakeImage {
    set src(_) {
      this.naturalWidth = W;
      this.naturalHeight = H;
      // mimic the browser firing onload async after src is set
      setTimeout(() => this.onload && this.onload(), 0);
    }
  };
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error('FakeDoc: only canvas supported');
      return {
        width: 0, height: 0,
        getContext() {
          return {
            drawImage() {},
            getImageData(_x, _y, w, h) {
              const data = new Uint8ClampedArray(w * h * 4);
              for (let i = 0; i < w * h; i++) {
                data[i*4+0] = 255; data[i*4+1] = 0; data[i*4+2] = 0; data[i*4+3] = 255;
              }
              return { data };
            },
          };
        },
      };
    },
  };
}
stubImageIO();
import importSvg from '../../src/svg/importer.js';

let failures = 0;
const ok   = (msg) => console.log('ok', msg);
const fail = (msg) => { failures++; console.error('FAIL', msg); };

const STRIDE = 48;
const META_MASKID = 31;
const META_CLIPID = 30;
const META_FLAGS  = 27;
const FLAG_LAYER  = 0x100;

function inspect(sections) {
  const mf = new Float32Array(sections.meta, 32);
  const rows = [];
  for (let i = 0; i < sections.numShapes; i++) {
    const b = i * STRIDE;
    const flags = (mf[b + META_FLAGS] + 0.5) | 0;
    rows.push({
      idx: i,
      maskId: (mf[b + META_MASKID] + 0.5) | 0,
      clipId: (mf[b + META_CLIPID] + 0.5) | 0,
      isLayer: (flags & FLAG_LAYER) !== 0,
      id: sections.shapeIds[i],
    });
  }
  return rows;
}

// ---- T1: <image> inside <g mask=> inherits the mask -----------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><mask id="m"><rect x="0" y="50" width="100" height="50" fill="#fff"/></mask></defs>
  <g mask="url(#m)">
    <rect x="0" y="0" width="100" height="100" fill="#ff0000"/>
    <image href="x://bitmap.png" x="0" y="0" width="100" height="100"/>
  </g>
</svg>`;
  const s = await importSvg(svg);
  const rows = inspect(s);
  const visibleRows = rows.filter(r => !r.isLayer);
  const layerRows = rows.filter(r => r.isLayer);
  if (visibleRows.length < 2)
    fail(`T1 expected ≥ 2 visible rows (rect + image), got ${visibleRows.length}: ${JSON.stringify(rows)}`);
  else if (visibleRows.some(r => r.maskId === 0))
    fail(`T1 one or more visible rows have maskId=0 (mask didn't inherit). Rows: ${JSON.stringify(visibleRows)}`);
  else if (layerRows.length === 0)
    fail(`T1 no FLAG_LAYER mask geometry row emitted`);
  else {
    const uniqueMasks = new Set(visibleRows.map(r => r.maskId));
    if (uniqueMasks.size !== 1)
      fail(`T1 visible rows reference DIFFERENT mask ids (rect vs image): ${[...uniqueMasks]}`);
    else
      ok(`T1 <image> inside <g mask=> inherits mask (id=${[...uniqueMasks][0]} shared with rect)`);
  }
}

// ---- T2: <image> with its OWN mask attribute ------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><mask id="m"><rect x="0" y="0" width="100" height="40" fill="#fff"/></mask></defs>
  <image href="x://bitmap.png" x="0" y="0" width="100" height="100" mask="url(#m)"/>
</svg>`;
  const s = await importSvg(svg);
  const rows = inspect(s);
  const visibleRows = rows.filter(r => !r.isLayer);
  if (visibleRows.length < 1)
    fail(`T2 expected ≥ 1 image row, got ${visibleRows.length}`);
  else if (visibleRows.some(r => r.maskId === 0))
    fail(`T2 <image mask=> glyphs have maskId=0: ${JSON.stringify(visibleRows)}`);
  else
    ok(`T2 <image mask="..."> direct attribute consumed (id=${visibleRows[0].maskId})`);
}

// ---- T3: <image> inside <g clip-path=> inherits the clip ------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><clipPath id="c"><rect x="0" y="0" width="100" height="50"/></clipPath></defs>
  <g clip-path="url(#c)">
    <image href="x://bitmap.png" x="0" y="0" width="100" height="100"/>
  </g>
</svg>`;
  const s = await importSvg(svg);
  const rows = inspect(s);
  const visibleRows = rows.filter(r => !r.isLayer);
  if (visibleRows.some(r => r.clipId === 0))
    fail(`T3 <image> inside <g clip-path=> has clipId=0: ${JSON.stringify(visibleRows)}`);
  else
    ok(`T3 <image> inside <g clip-path=> inherits the clip`);
}

// ---- T4: bare <image> (no mask anywhere) — no inheritance ghost -----
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <image href="x://bitmap.png" x="0" y="0" width="100" height="100"/>
</svg>`;
  const s = await importSvg(svg);
  const rows = inspect(s);
  if (rows.some(r => r.maskId !== 0 || r.clipId !== 0))
    fail(`T4 plain <image> picked up a phantom mask/clip: ${JSON.stringify(rows)}`);
  else
    ok(`T4 bare <image> with no mask/clip in ancestry stays at 0 (no ghost inheritance)`);
}

console.log();
console.log(failures === 0 ? 'IMAGE-MASK-INHERITANCE PASS' : `IMAGE-MASK-INHERITANCE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
