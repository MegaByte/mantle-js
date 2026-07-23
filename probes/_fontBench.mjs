// _fontBench — AAC vs Slug on TEXT, at a range of font sizes.
//
// Text is the extreme case of the many-small-shapes regime that the sprite sheet
// (jumpLongSplash) exposed: one shape per glyph, ~30 segments each, tiny cover
// quads, and — for a TrueType face like Roboto — almost all QUADRATIC segments.
// That is exactly where AAC's per-fragment fixed cost (its big kernel limits
// occupancy) is amortised over the least per-segment work.
//
// Font size is the knob that moves it: bigger glyphs ⇒ more fragments per segment
// ⇒ AAC's per-segment advantage gets something to pay for its fixed cost.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const W = 1600, H = 900;
// FONT=<path> to bench a different face. Roboto is TrueType (quads); a CFF/OTF
// face is cubics, and the two take DIFFERENT px² thresholds in preferAac.
const FONT = process.env.FONT || path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
const ttf = Array.from(new Uint8Array(readFileSync(FONT)));
// ~600 glyphs: enough to be fragment-bound rather than draw-call bound
// Two regimes, so draw-bound and fragment-bound are not conflated:
//   many tiny glyphs  → per-shape/per-draw cost dominates
//   few huge glyphs   → per-fragment cost dominates
const LINE = 'Handgloves quick brown fox jumps over the lazy dog 0123456789 ';
// NOTE: a bundle drawn with no worldMatrix fits its globalBBox to the viewport, so
// fontSize CANCELS out of the em→px chain — px²/shape is set by each glyph's share
// of the run bbox, i.e. by GLYPH COUNT, not by point size. Sweep glyph count.
const GLYPHS = (process.env.GLYPHS || '').split(',').filter(Boolean).map(Number);
const CASES = GLYPHS.length
  ? GLYPHS.map((n) => [`${String(n).padStart(3)} glyphs`, LINE.repeat(Math.ceil(n/LINE.length)).slice(0, n), 48])
  : [
  ['520 glyphs @  8px', LINE.repeat(10), 8],
  ['520 glyphs @ 12px', LINE.repeat(10), 12],
  [' 52 glyphs @ 24px', LINE, 24],
  [' 10 glyphs @ 90px', 'Handgloves', 90],
  ['  3 glyphs @260px', 'Hgo', 260],
  ['  1 glyph  @700px', 'g', 700],
];

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const rA=createRenderer(gl,shaders,{aacFill:true}); rA.setViewport(${W},${H}); rA.setLoopBlinnFill('off');
// Roboto is TrueType ⇒ quadratics only. Compile out the arc + cubic kernels.
// typeOmit derives the omits from bundle.segTypeMask — no hand-written defines.
const rAlean=createRenderer(gl,shaders,{aacFill:true, typeOmit:true});
rAlean.setViewport(${W},${H}); rAlean.setLoopBlinnFill('off');
const rSlean=createRenderer(gl,shaders,{typeOmit:true});
rSlean.setViewport(${W},${H}); rSlean.setLoopBlinnFill('off');
// aacFill:'auto' — pick per bundle from mean shape px area
const rAuto=createRenderer(gl,shaders,{aacFill:'auto', typeOmit:true});
rAuto.setViewport(${W},${H}); rAuto.setLoopBlinnFill('off');
const rS=createRenderer(gl,shaders,{});            rS.setViewport(${W},${H}); rS.setLoopBlinnFill('off');
const K=Number(${JSON.stringify(process.env.REPS||'12')});
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
window.__runCases = async (ttf, cases) => {
  const font = new MantleFontAsset(new Uint8Array(ttf));
  const out = {};
  for (const [label, text, px] of cases) {
    const tb = await createTextBundle(gl, { font, text, style: { fontSize: px, fill: [0,0,0,1] } });
    const amort = (r) => {
      r.prepareBundle && r.prepareBundle(tb.bundle);
      const runs = [];
      for (let rep=0; rep<9; rep++){
        r.beginFrame([1,1,1,1]); for(let i=0;i<3;i++) r.drawBundle(tb); r.endFrame(); sync();
        const t0=performance.now();
        r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(tb); r.endFrame(); sync();
        runs.push((performance.now()-t0)/K);
      }
      runs.sort((a,b)=>a-b);
      return runs[Math.floor(runs.length/2)];   // median: min-of-N is biased low and noisy
    };
    // px² the selector actually sees (drawn once so R.draw is populated)
    rAuto.beginFrame([1,1,1,1]); rAuto.drawBundle(tb); rAuto.endFrame(); sync();
    const px2 = rAuto.debugStats.autoMeanShapePx2;
    const eng = rAuto.debugStats.autoEngine;
    // GPU clocks ramp across a run, so whichever renderer is measured LAST looks
    // fastest. That bias was ~13% — larger than the effects we are fitting. Measure
    // every renderer in forward order, then again in reverse, and take the min per
    // renderer: each one then gets one early (cold) and one late (warm) slot.
    const R = { slug: rS, slean: rSlean, aac: rA, lean: rAlean, auto: rAuto };
    const names = Object.keys(R);
    const fwd = {}, rev = {};
    for (const n of names) fwd[n] = amort(R[n]);
    for (const n of names.slice().reverse()) rev[n] = amort(R[n]);
    const t = {}; for (const n of names) t[n] = Math.min(fwd[n], rev[n]);
    out[label] = { ...t, shapes: tb.bundle.numShapes, mask: tb.bundle.segTypeMask, area: tb.bundle.meanShapeArea, px2, eng };
  }
  return out;
};
window.__ready = true;
</script></body></html>`;
const server=http.createServer((q,res)=>{try{if(q.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;}const pp=decodeURIComponent(q.url.split('?')[0]);res.writeHead(200,{'content-type':pp.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,pp)));}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const br=await puppeteer.launch({headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const pg=await br.newPage(); pg.on('pageerror',e=>console.error(' [err]',e.message));
await pg.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:90000});
await pg.waitForFunction(()=>window.__ready===true,{timeout:90000});
const o = await pg.evaluate((t,c)=>window.__runCases(t,c), ttf, CASES);
await br.close(); server.close();
console.log(`${path.basename(FONT)}  (mask 0b${((o[CASES[0][0]]||{}).mask||0).toString(2).padStart(4,'0')} = ${(((o[CASES[0][0]]||{}).mask||0)&4)?'CUBIC':'QUAD'})\n`);
console.log('case                 shapes    px2/shape | slugLean  aacLean |   AUTO   vs best  picked');
for (const [label] of CASES) {
  const r = o[label];
  const best=Math.min(r.slean,r.lean);
  const picked = (r.eng||'?').toUpperCase();
  console.log(`${label.padEnd(20)} ${String(r.shapes).padStart(6)} ${String(Math.round(r.px2||0)).padStart(12)} | ${r.slean.toFixed(4)}  ${r.lean.toFixed(4)} | ${r.auto.toFixed(4)}   ${(r.auto/best).toFixed(3)}   ${picked}`);
}
