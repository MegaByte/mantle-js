// _predicateHeat — G8's precondition. The exact-sign predicates fall back to a BigInt
// evaluation when the float filter is uncertain, and BigInt allocates. The gap analysis says a
// DoubleDouble middle tier (JTS-style) is "only worth it if the exact path ever profiles hot
// (measured rare)". This measures it instead of assuming.
//
// Reports, for real content: total orient2d/incircle calls made during LB mesh construction, and
// what fraction reached the adaptive (expansion) path, and the fully-expanded exact level.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROBOTO = Array.from(new Uint8Array(readFileSync(ROOT + '/test/font/fixtures/roboto-regular.ttf')));
const TIGER = readFileSync(ROOT + '/examples/tiger.svg', 'utf8');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
import { predicateStats, resetPredicateStats } from '/src/renderer/predicates.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
// Force the CDT path for every shape, so the predicates are actually exercised: the earcut fast
// mesh does not call them at all.
window.__run=async(tiger, fontBytes, forceCdt)=>{
  r.setLoopBlinnMeshOpts({ forceCdt: !!forceCdt });
  const out=[];
  const t0=performance.now();
  resetPredicateStats();
  { const b=createBundle(gl, await importSvg(tiger)); r.prepareBundle(b);
    out.push({name:'tiger', ms:performance.now()-t0, ...JSON.parse(JSON.stringify(predicateStats))});
    b.dispose(); }
  const t1=performance.now();
  resetPredicateStats();
  { const font=new MantleFontAsset(new Uint8Array(fontBytes));
    const tb=await createTextBundle(gl,{font,text:'NAWMgo8 Hamburgefonstiv',style:{fontSize:64,fill:[0,0,0,1]}});
    const bun=tb.bundle||tb; r.prepareBundle(bun);
    out.push({name:'glyphs', ms:performance.now()-t1, ...JSON.parse(JSON.stringify(predicateStats))});
    tb.dispose&&tb.dispose(); }
  r.setLoopBlinnMeshOpts({ forceCdt: false });
  return out;
};
window.__ready=true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
// A FRESH PAGE per setting: the LB mesh cache is module-level, so a second run in the same page
// returns cached meshes, builds nothing, and reports zero predicate calls.
for (const forceCdt of [false, true]) {
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  const o = await pg.evaluate((t, f, fc) => window.__run(t, f, fc), TIGER, ROBOTO, forceCdt);
  console.log(`\n  ${forceCdt ? 'FORCE_CDT=1 (every shape through the CDT)' : 'default routing (earcut fast mesh where possible)'}`);
  for (const r of o) {
    const oe = r.orient2d ? (100 * r.orient2dAdapt / r.orient2d) : 0;
    const ie = r.incircle ? (100 * r.incircleAdapt / r.incircle) : 0;
    console.log(`    ${r.name.padEnd(7)} build ${r.ms.toFixed(0).padStart(5)}ms`);
    console.log(`            orient2d ${String(r.orient2d).padStart(8)}  adaptive ${String(r.orient2dAdapt).padStart(5)}  fully-exact ${String(r.orient2dExact).padStart(5)} (${oe.toFixed(3)}%)`);
    console.log(`            incircle ${String(r.incircle).padStart(8)}  adaptive ${String(r.incircleAdapt).padStart(5)}  fully-exact ${String(r.incircleExact).padStart(5)} (${ie.toFixed(3)}%)`);
  }
  await pg.close();
}
await br.close(); server.close();
