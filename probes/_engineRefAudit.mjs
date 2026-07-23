// _engineRefAudit — judge EVERY fill engine against the browser's SVG
// rasteriser (test/_svgRef.js), and log the broken cases.
//
// This is the referee the smokes lacked. Slug and AAC were previously used to
// check each other, which cannot detect an error they share and silently
// degenerates where the two agree by construction (circles route to the kind-7
// SDF disc, strokes never reach a fill kernel — `aacFill: true` is BYTE-IDENTICAL
// to Slug for both).
//
//   node probes/_engineRefAudit.mjs            # summary table
//   TOL=0.02 node probes/_engineRefAudit.mjs   # per-pixel coverage tolerance
//   CASE=cubic node probes/_engineRefAudit.mjs # one case
import { readFileSync, readdirSync, statSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MANTLE_ROOT
  ? path.resolve(process.env.MANTLE_ROOT)
  : HERE_ROOT;
const N = +(process.env.N || 128);
const TOL = +(process.env.TOL || 0.02);
const ONLY = process.env.CASE || '';

// Content chosen to separate the engines' KERNELS, not to look pretty: one
// primitive per row wherever possible, plus the junction/thin cases that have
// historically hidden defects.
// CORPUS=<comma-separated svg paths> audits REAL assets instead of the synthetic
// set. This combination is the gap that let visible missing-paint through: the
// synthetic cases were scored against the browser reference (all pixels, so
// interior dropout IS visible), and the real assets were only ever run through
// the PERF bench. Neither alone catches a white wedge inside a real shape.
function collectSvg(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (/^(?:node_modules|\.git)$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSvg(file, out);
    else if (/\.svg$/i.test(entry.name)) {
      try { const size = statSync(file).size; if (size >= 400 && size <= +(process.env.MAX_BYTES || 180_000)) out.push(file); } catch { /* skip */ }
    }
  }
  return out;
}
function sampleSvg(files, limit) {
  files.sort();
  if (files.length <= limit) return files;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(files[Math.floor(i * files.length / limit)]);
  return out;
}
const CORPUS_FILES = process.env.CORPUS
  ? process.env.CORPUS.split(',').map((f) => f.trim())
  : process.env.CORPUS_DIR
    ? sampleSvg(collectSvg(path.resolve(process.env.CORPUS_DIR)), +(process.env.LIMIT || 48))
    : null;
const CASES = {
  poly:      '<polygon points="14,14 110,30 96,110 30,96" fill="#000"/>',
  tri:       '<polygon points="64,12 116,112 12,112" fill="#000"/>',
  // NOTE: authored as PATHS, not <rect>/<circle>. The importer tags those with a
  // primKind SDF fast path (circle=1, rect=2, roundRect=3, importWalkShapes.js
  // ~219) that is handled analytically in the shader, bypassing the Slug AND AAC
  // walkers and making LB decline the bundle outright. That fast path is correct
  // and worth shipping, but it means <rect>/<circle> test the SDF, not the fill
  // engines. Same geometry as a path keeps primKind 0 and exercises the real
  // kernels — which is the point of this audit.
  rect:      '<path d="M16 24 H112 V96 H16 Z" fill="#000"/>',
  // SDF fast-path variants of the same geometry. These SHIP (primKind 1/2/3), so
  // they are measured as first-class rows rather than merely avoided.
  rectSDF:   '<rect x="16" y="24" width="96" height="72" fill="#000"/>',
  circleSDF: '<circle cx="64" cy="64" r="46" fill="#000"/>',
  rrectSDF:  '<rect x="16" y="24" width="96" height="72" rx="14" fill="#000"/>',
  quad:      '<path d="M14 96 Q64 4 114 96 Z" fill="#000"/>',
  cubic:     '<path d="M14 96 C34 8 94 8 114 96 Z" fill="#000"/>',
  cubicS:    '<path d="M16 64 C16 16 112 112 112 64 Z" fill="#000"/>',
  // same arch rotated 90 deg: if the band defect stays HORIZONTAL it is the
  // H-ray walker; if it rotates with the shape it is the geometry.
  cubicRot:  '<path d="M96 14 C8 34 8 94 96 114 Z" fill="#000"/>',
  // isolation variants for the slug cubic band defect
  cubTilt:   '<path d="M14 96 C34 8 94 8 114 90 Z" fill="#000"/>',
  cubSymA0:  '<path d="M14 96 C34 8 94 20 114 96 Z" fill="#000"/>',
  cubQuad:   '<path d="M14 96 Q64 12 114 96 Z" fill="#000"/>',
  cubShift:  '<path d="M14 95 C34 7 94 7 114 95 Z" fill="#000"/>',
  arc:       '<path d="M20 64 A44 44 0 1 1 108 64 A44 44 0 1 1 20 64 Z" fill="#000"/>',
  circle:    '<path d="M18 64 A46 46 0 1 0 110 64 A46 46 0 1 0 18 64 Z" fill="#000"/>',
  ellipse:   '<ellipse cx="64" cy="64" rx="52" ry="30" fill="#000"/>',
  holeEO:    '<path d="M10 10 H118 V118 H10 Z M40 40 H88 V88 H40 Z" fill="#000" fill-rule="evenodd"/>',
  holeNZ:    '<path d="M10 10 H118 V118 H10 Z M40 88 H88 V40 H40 Z" fill="#000"/>',
  thin:      '<path d="M12 60 L116 62 L116 68 L12 66 Z" fill="#000"/>',
  hairline:  '<path d="M12 63 H116 V64.2 H12 Z" fill="#000"/>',
  cusp:      '<path d="M20 100 C100 20 28 20 108 100 Z" fill="#000"/>',
  // partition/clipToInk9 exercisers: faces that reach ACROSS a second boundary
  // (the '8' waist, a thin ring channel) — where the sampled chord clip lives.
  waist:     '<path d="M64 12 C104 12 104 60 64 60 C24 60 24 12 64 12 Z M64 68 C104 68 104 116 64 116 C24 116 24 68 64 68 Z" fill="#000"/>',
  thinRing:  '<path d="M64 8 A56 56 0 1 0 64 120 A56 56 0 1 0 64 8 Z M64 16 A48 48 0 1 1 64 112 A48 48 0 1 1 64 16 Z" fill="#000" fill-rule="evenodd"/>',
  selfX:     '<path d="M20 20 L108 108 L108 20 L20 108 Z" fill="#000"/>',
  // same bowtie, slightly off 45 deg: separates a real edge-AA defect from the
  // knife-edge case where a 45 deg boundary lands exactly on pixel CENTRES.
  selfXrot:  '<path d="M20 24 L108 104 L108 20 L20 108 Z" fill="#000"/>',
  gradient:  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#999"/></linearGradient></defs><path d="M18 64 A46 46 0 1 0 110 64 A46 46 0 1 0 18 64 Z" fill="url(#g)"/>',
  strokeQ:   '<path d="M20 100 Q64 10 108 100" fill="none" stroke="#000" stroke-width="9"/>',
  strokeJoin:'<path d="M20 100 L64 24 L108 100" fill="none" stroke="#000" stroke-width="12" stroke-linejoin="miter"/>',
  // CURVE-to-CURVE miter join — exercises _strokeMath.glsl's join path, which the
  // line-segment cases above never reach.
  strokeQJoin:'<path d="M16 104 Q40 40 64 32 Q88 40 112 104" fill="none" stroke="#000" stroke-width="11" stroke-linejoin="miter"/>',
  strokeSharp:'<path d="M20 108 Q52 60 64 20 Q76 60 108 108" fill="none" stroke="#000" stroke-width="10" stroke-linejoin="miter"/>',
};

// 'auto' is the SHIPPING config and is the true limiter for what users see, so it
// is audited alongside the forced paths. The forced rows stay: we want to improve
// every path, not only the one auto happens to pick today.
// ENGSET=slugaa swaps the columns for a Slug-AA comparison: does Slug with its
// higher-accuracy AA opts reach AAC's accuracy? (AAC costs 1.03-1.60x Slug on the
// fill bench, so a cheaper route to the same accuracy would matter.)
if (CORPUS_FILES) {
  for (const k of Object.keys(CASES)) delete CASES[k];
  let corpusIndex = 0;
  for (const f of CORPUS_FILES) {
    const key = `${String(corpusIndex++).padStart(3, '0')}_${path.basename(f).replace(/\.svg$/, '').slice(0, 20)}`;
    try { CASES[key] = readFileSync(f, 'utf8'); } catch { /* skip */ }
  }
}
if (process.env.CASE_START || process.env.CASE_COUNT) {
  const keys = Object.keys(CASES);
  const start = +(process.env.CASE_START || 0);
  const count = +(process.env.CASE_COUNT || keys.length);
  const keep = new Set(keys.slice(start, start + count));
  for (const key of keys) if (!keep.has(key)) delete CASES[key];
}
const ENGINES = process.env.ENGSET === 'lb' ? [
  ['slug', '{}',                    "'off'"],
  ['lb',   '{}',                    "'on'"],
] : process.env.ENGSET === 'slugaa' ? [
  ['slug', '{}',                        "'off'"],
  ['exact', '{ exactEdgeAa: true }',    "'off'"],
  ['slope', '{ slopeAa: true }',        "'off'"],
  ['aac',  '{ aacFill: true }',         "'off'"],
] : [
  ['slug', '{}',                    "'off'"],
  ['aac',  '{ aacFill: true }',     "'off'"],
  ['lb',   '{}',                    "'on'"],
  ['auto', "{ aacFill: 'auto' }",   "'auto'"],
];
const COLS = ENGINES.map((e) => e[0]);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
if (${process.env.DISABLE_WORKERS === '1'}) globalThis.Worker = undefined;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { svgCoverage, compareRGB } from '/test/_svgRef.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true, depth:true, stencil:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
globalThis.__REF_P = ${+(process.env.REFP||1024)};
const CASES = ${JSON.stringify(CASES)};
const mk = (o, lb) => { const r = createRenderer(gl, shaders, o); r.setViewport(${N}, ${N}); r.setLoopBlinnFill(lb); return r; };
const ENG = [${ENGINES.map(([n, o, l]) => `['${n}', mk(${o}, ${l})]`).join(',')}];
const read = () => { const p = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const out = [];
for (const k in CASES) {
  if (${JSON.stringify(ONLY)} && k !== ${JSON.stringify(ONLY)}) continue;
  // NOTE ON THE FIT: pinning it with a full-viewBox white backing rect works and
  // is exact, but the extra shape makes LB decline the bundle entirely (routed=0
  // on every case), so the lb column silently became a second slug column. The
  // reference reproduces the fit accurately enough without it — see _svgRef.js.
  // STROKE cases get a full-viewBox white backing rect. The renderer fits the
  // INKED extent, and for a stroked path the reference cannot reproduce that fit:
  // getBBox() excludes stroke width, and a rasterised ink bbox disagrees with
  // whatever the renderer uses for caps/miters (measured: strokeQ off by 2px,
  // strokeJoin off in SCALE — ref height 118 vs render 112). The backing rect
  // inks the full viewBox for BOTH sides, pinning the mapping to identity and
  // removing the fit from the comparison entirely. It is invisible against the
  // white clear. Safe here precisely because stroked content never routes through
  // LB, so the extra shape cannot make LB decline the bundle (which is why the
  // FILL cases must not use this trick).
  const isStroke = /stroke=/.test(CASES[k]) && /fill="none"/.test(CASES[k]);
  // A file may open with an <?xml?> prolog or a comment, so 'starts with <svg'
  // is the wrong test: it wrapped Ghostscript_Tiger in a SECOND <svg>, leaving an
  // XML prolog mid-document, and the browser silently refused the whole thing.
  // 'starts with <svg' was the wrong test: a file may open with an <?xml?> prolog,
  // and Ghostscript_Tiger got wrapped in a SECOND <svg> with the prolog left
  // mid-document, which the browser silently refuses.
  //
  // Written WITHOUT a regex on purpose. This whole script is the body of a
  // template literal, where an untagged \s collapses to a bare 's' — the first
  // cut here used /<svg[\s>]/ and shipped as /<svg[s>]/, which matches nothing
  // and silently kept the broken wrap. Slicing from '<svg' also drops the prolog.
  const _i = CASES[k].indexOf('<svg');
  const svg = _i >= 0 ? CASES[k].slice(_i)
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${N}" height="${N}">'
      + (isStroke ? '<rect x="0" y="0" width="128" height="128" fill="#ffffff"/>' : '') + CASES[k] + '</svg>';
  let ref;
  let _fb = null; try { _fb = await importSvg(svg); } catch { _fb = null; }
  try { ref = await svgCoverage(svg, ${N}, ${N}, ${+(process.env.REFSS || 0)} || Math.max(4, Math.min(16, Math.floor(4096 / ${N}))),
                                _fb && _fb.globalBBox); }
  catch (e) { out.push({ k, err: String(e.message) }); continue; }
  if (${JSON.stringify(process.env.BBOXCHK||'')}) {   // does the reference FIT match the renderer's?
    const _b = await importSvg(svg);
    const g = _b.globalBBox;
    const hostD = document.createElement('div');
    hostD.style.cssText = 'position:absolute;left:-9999px';
    hostD.innerHTML = svg; document.body.appendChild(hostD);
    let gb = null;
    try { const q = hostD.querySelector('svg').getBBox(); gb = [q.x, q.y, q.width, q.height]; } catch {}
    hostD.remove();
    console.error('BB\t' + k + '\timporter=' + JSON.stringify(g.map(v=>+v.toFixed(3)))
                + '\tgetBBox=' + JSON.stringify(gb && gb.map(v=>+v.toFixed(3))));
  }
  const row = { k, eng: {} };
  for (const [name, r] of ENG) {
    const b = createBundle(gl, await importSvg(svg));
    r.prepareBundle(b);
    if (!${process.env.SKIP_LB_READY === '1'} && r.awaitLbReady) { try { await r.awaitLbReady(b); } catch {} }
    const _c0 = r.debugStats ? r.debugStats.loopBlinnRouteCount : 0;
    // awaitLbReady covers the WORKER build, but _ensureLbMeshes finishes the rest
    // at DRAW time under an 8ms budget, so in principle one frame could measure a
    // partially built bundle. MEASURED on the heaviest asset (Ghostscript_Tiger,
    // 304 shapes): identical at 1, 12 and 60 frames — drop=49 wrong=2635 every
    // time. The result is stable, so one frame is enough; FRAMES stays as a knob
    // for re-checking that on new content rather than assuming it.
    const _frames = +${JSON.stringify(process.env.FRAMES||'1')};
    for (let _f = 0; _f < _frames; _f++) { r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); }
    const _routed = (r.debugStats ? r.debugStats.loopBlinnRouteCount : 0) - _c0;
    const _px = read();
    row.eng[name] = compareRGB(ref, _px, ${N}, ${N}, { tol: ${TOL} });
    // Three DIRECTIONAL defect classes. The earlier single "HOLES" number could
    // not tell them apart and mislabelled over-fill as dropout: ref.cov is
    // GEOMETRIC coverage of any shape, so a white-filled path gives cov=1 with a
    // white colour, and a dark shape bleeding over it scored as a "hole".
    // Direction is read against the CLEAR colour (white) instead:
    //   DROP  ref is inked, render left it ~white          -> missing paint
    //   WRONG ref is inked, render painted a DIFFERENT ink -> z-order / over-fill
    //   OVER  ref is outside every shape, render painted   -> paint beyond the silhouette
    { let nDrop = 0, nWrong = 0, nOver = 0, worst = 0, wx = 0, wy = 0, wcls = '-';
      const hpts = [];
      const isClear = (q) => _px[q] > 242 && _px[q + 1] > 242 && _px[q + 2] > 242;
      for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
        const i2 = y * ${N} + x;
        const q = ((${N} - 1 - y) * ${N} + x) * 4;
        if (ref.cov[i2] <= 0.005) {                        // outside the reference silhouette
          if (!isClear(q)) { nOver++; hpts.push([x, y, 1, 'OVER']); }
          continue;
        }
        if (ref.cov[i2] < 0.995) continue;                 // only fully-covered reference
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(ref.rgba[i2 * 4 + c] - _px[q + c]) / 255);
        if (d <= 0.15) continue;
        const refClear = ref.rgba[i2 * 4] > 242 && ref.rgba[i2 * 4 + 1] > 242 && ref.rgba[i2 * 4 + 2] > 242;
        const cls = (isClear(q) && !refClear) ? 'DROP' : 'WRONG';
        cls === 'DROP' ? nDrop++ : nWrong++;
        hpts.push([x, y, +d.toFixed(2), cls]);
        if (d > worst) { worst = d; wx = x; wy = y; wcls = cls; }
      }
      { let rb = 0, gb = 0;   // near-black pixel counts, reference vs render
        for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
          const i3 = y * ${N} + x, q3 = ((${N} - 1 - y) * ${N} + x) * 4;
          if (ref.rgba[i3*4] < 40 && ref.rgba[i3*4+1] < 40 && ref.rgba[i3*4+2] < 40) rb++;
          if (_px[q3] < 40 && _px[q3+1] < 40 && _px[q3+2] < 40) gb++; }
        row.eng[name].blkRef = rb; row.eng[name].blkGot = gb; }
      row.eng[name].hole = nDrop; row.eng[name].wrong = nWrong; row.eng[name].over = nOver;
      row.eng[name].holeMax = +worst.toFixed(3);
      row.eng[name].holeAt = wx + ',' + wy + ' ' + wcls;
      if (${JSON.stringify(process.env.HOLEMAP||'')} === name) {
        const bx = {}; for (const h of hpts) { const kk = h[3] + ' ' + (h[0] >> 6) + ',' + (h[1] >> 6); bx[kk] = (bx[kk] || 0) + 1; }
        hpts.sort((a2, b2) => b2[2] - a2[2]);
        const hy = {}, hxx = {};
        for (const h of hpts) { const by = (h[1] >> 4) << 4, bxk = (h[0] >> 4) << 4;
          hy[by] = (hy[by] || 0) + 1; hxx[bxk] = (hxx[bxk] || 0) + 1; }
        row.holeDbg = ['cells: ' + JSON.stringify(bx),
                       'by y/16: ' + JSON.stringify(hy),
                       'by x/16: ' + JSON.stringify(hxx)]
          .concat(hpts.slice(0, 10).map((h) => '  ' + h[3] + ' ' + h.slice(0, 3).join(',')));
      } }
    row.eng[name].routed = _routed;
    if (name === 'slug') row._slug = Array.from(_px);
    else { let same = true;
      for (let i = 0; i < _px.length; i += 4) if (_px[i] !== row._slug[i]) { same = false; break; }
      row.eng[name].sameAsSlug = same; }
    if (k === ${JSON.stringify(process.env.MAP||'')} && name === ${JSON.stringify(process.env.MAPENG||'slug')}) {
      const gc=(x,y)=>1-_px[((${N}-1-y)*${N}+x)*4]/255;
      let rows=[];
      if (${JSON.stringify(process.env.HOT||'')}) {   // cluster map of gross pixels
        const hits=[];
        for(let y=0;y<${N};y++)for(let x=0;x<${N};x++){
          const d=Math.abs((1-ref.rgba[(y*${N}+x)*4]/255)-gc(x,y));
          if(d>${+(process.env.HOTTH||0.25)}) hits.push([x,y,+d.toFixed(2)]); }
        rows.push('gross pixels: '+hits.length);
        const bx={};
        for(const h of hits){ const k=(h[0]>>6)+','+(h[1]>>6); bx[k]=(bx[k]||0)+1; }
        rows.push('by 64px cell: '+JSON.stringify(bx));
        hits.sort((a,b)=>b[2]-a[2]);
        for(const h of hits.slice(0,14)) rows.push('  hit '+h.join(','));
      }
      else if (${JSON.stringify(process.env.PIX||'')}) {   // full RGB triples at named pixels
        for (const t of ${JSON.stringify(process.env.PIX||'')}.split(';')) {
          const [x,y]=t.split(',').map(Number);
          const ri=(y*${N}+x)*4, gi=((${N}-1-y)*${N}+x)*4;
          rows.push('('+x+','+y+') ref=rgb('+ref.rgba[ri]+','+ref.rgba[ri+1]+','+ref.rgba[ri+2]+')'
                    +'  got=rgb('+_px[gi]+','+_px[gi+1]+','+_px[gi+2]+')'); } }
      else if (${JSON.stringify(process.env.COL||'')}) { const X=+${JSON.stringify(process.env.COL||'64')};
        for(let y=0;y<${N};y++){ const rr=1-ref.rgba[(y*${N}+X)*4]/255, gg=gc(X,y);
          if (Math.abs(rr-gg)>0.02||rr>0.01) rows.push('y='+String(y).padStart(3)+' ref='+rr.toFixed(3)+' got='+gg.toFixed(3)+' d='+(rr-gg).toFixed(3)); } }
      else { for(let y=0;y<${N};y+=8){ let ln='';
        for(let x=0;x<${N};x+=4){ const d=Math.abs((1-ref.rgba[(y*${N}+x)*4]/255)-gc(x,y));
          ln += d<0.02?'.':d<0.2?'-':d<0.6?'+':'#'; } rows.push(ln); } }
      // Record both ink extents to distinguish offset from scale errors.
      { let rx0=1e9,ry0=1e9,rx1=-1,ry1=-1,gx0=1e9,gy0=1e9,gx1=-1,gy1=-1;
        for(let y=0;y<${N};y++)for(let x=0;x<${N};x++){
          if(ref.cov[y*${N}+x]>0.5){if(x<rx0)rx0=x;if(x>rx1)rx1=x;if(y<ry0)ry0=y;if(y>ry1)ry1=y;}
          if(gc(x,y)>0.5){if(x<gx0)gx0=x;if(x>gx1)gx1=x;if(y<gy0)gy0=y;if(y>gy1)gy1=y;} }
        rows.push('REF ink bbox x['+rx0+','+rx1+'] y['+ry0+','+ry1+']');
        rows.push('GOT ink bbox x['+gx0+','+gx1+'] y['+gy0+','+gy1+']'); }
      row.dbg = rows; }
    if (${JSON.stringify(process.env.FBSTAT||'')} && name === 'lb')
      console.error('FB\t' + k + '\ttotal=' + (globalThis.__FB||0) + '\tnoFn=' + (globalThis.__FB_NOFN||0)
        + '\treturnedFalse=' + (globalThis.__FB_FALSE||0) + '\tdrew=' + (globalThis.__FB_OK||0));
    b.dispose();
  }
  delete row._slug; out.push(row);
}
window.__out = out; window.__ready = true;
</${'script'}></body></html>`;

const server = http.createServer((q, res) => {
  const f = q.url.split('?')[0];
  if (f === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
  try {
    // Historical renderer worktrees predate this independent reference helper;
    // keep the referee fixed while swapping only the implementation under test.
    const sourceRoot = f === '/test/_svgRef.js' ? HERE_ROOT : ROOT;
    const body = readFileSync(path.join(sourceRoot, f));
    const ext = path.extname(f);
    res.writeHead(200, { 'Content-Type': ext === '.js' || ext === '.mjs' ? 'text/javascript' : ext === '.glsl' ? 'text/plain' : 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
// GPU=1 → real GPU (headful ANGLE-Metal). The default headless backend is
// SwiftShader-class, which under-reports straight-edge AA and diverges on
// fwidth; fill-coverage residue (tiger #4, corpus #5) should be re-checked here.
const browser = await puppeteer.launch(process.env.GPU === '1'
  ? { headless: false, args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
  : { headless: 'new', args: process.env.SWIFTSHADER === '1'
      ? ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'] : ['--no-sandbox'] });
const pg = await browser.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
pg.on('console', (m) => { const t = m.text();
  if (m.type() === 'error' || (process.env.LOGWARN && /^(LB|CG|MESH)/.test(t))) console.error(' [console]', t); });
// The LB mesh build runs in a WORKER, and a worker has its OWN console that the
// page handler above never sees. Every build-time diagnostic was silently going
// nowhere, which is why LB build behaviour could only be guessed at from a
// node-side reproduction that does not necessarily match it.
pg.on('workercreated', (w) => {
  w.on('console', (m) => console.error(' [worker]', m.text()));
});
try {
  const cdp = await pg.target().createCDPSession();
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
} catch { /* worker capture is best-effort */ }
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction('window.__ready === true', { timeout: +(process.env.TIMEOUT || 180000), polling: 50 });
const o = await pg.evaluate(() => window.__out);
await browser.close(); server.close();

// A case is BROKEN for an engine when its worst pixel is nowhere near the truth.
// meanErr is reported too: a high mean with a low max is an AA calibration issue,
// a high max with a low mean is a localised defect (a dropped pixel or a notch).
const CASES_JS = CASES;
const BROKEN = +(process.env.BROKEN || 0.25);
console.log(`\n  fill engines vs the BROWSER SVG rasteriser (8x supersampled), tol=${TOL}\n`);
console.log('   case            ' + COLS.map((n) => (n + '  bad/max  DRP/WRN/OVR').padStart(24)).join(''));
const broken = [];
if (process.env.JSON) {   // machine-readable: parsing the padded table shifts columns
  for (const r of o) { if (!r.eng) continue;
    for (const [n, e] of Object.entries(r.eng))
      console.log(['J', r.k, n, e.hole||0, e.wrong||0, e.over||0, e.max, e.bad, e._declined?'declined':'-', e.blkRef, e.blkGot].join('\t')); }
}
for (const r of o) { if (r.holeDbg) for (const ln of r.holeDbg) console.log('   ' + ln);
  if (r.dbg) { console.log('   [err map: . ok  - small  + mid  # gross]'); for(const ln of r.dbg) console.log('   '+ln); }
  if (r.err) { console.log(`   ${r.k.padEnd(11)}  [reference failed] ${r.err}`); continue; }
  let line = '   ' + r.k.padEnd(11);
  for (const n of COLS) {
    const e = r.eng[n];
    // Only LB can DECLINE (falls back to Slug, so the cell would be a second slug
    // column). AAC always participates — `aacFill:true` bakes MANTLE_AAC into the
    // BASE program — so byte-identical-to-Slug means the two AGREE (both are exact
    // on straight edges), not that AAC sat out. The one real exception is
    // stroke-only content, which reaches no fill kernel at all.
    const stroke = /stroke=/.test(CASES_JS[r.k] || '') && /fill="none"/.test(CASES_JS[r.k] || '');
    const declined = (n === 'lb' && !e.routed) || (n === 'aac' && stroke);   // 'auto' never declines: whatever it picks IS the shipped result
    line += declined ? '        [declined]      '
                     : `${String(e.bad).padStart(7)}/${e.max.toFixed(2).padStart(4)}`
                       + ((e.hole || e.wrong || e.over)
                          ? `  ${String(e.hole||0).padStart(3)}/${String(e.wrong||0).padStart(3)}/${String(e.over||0).padStart(3)}`
                          : '      -     ');
    e._declined = declined;
    if (e.max >= BROKEN && !e._declined) broken.push({ case: r.k, engine: n, ...e });
  }
  console.log(line);
}
console.log(`\n  BROKEN (worst-pixel error >= ${BROKEN} coverage) — ${broken.length} case/engine pairs:`);
if (!broken.length) console.log('   (none)');
for (const b of broken)
  console.log(`   ${b.engine.padEnd(5)} ${b.case.padEnd(11)} max=${b.max.toFixed(3)} mean=${b.mean} bad=${b.bad}/${b.ink}px`
    + `  worst @(${b.worst.x},${b.worst.y}) ref=${b.worst.ref} got=${b.worst.got}`);
