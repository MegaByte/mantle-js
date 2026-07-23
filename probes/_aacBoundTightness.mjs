// _aacBoundTightness — how much does the CONTROL-HULL bbox over-bound the curve,
// and what does that cost at render time?
//
// buildTexturesShape uses segCtrlBboxInto (convex hull of the control points) for
// BOTH the y-band binning and the `breakAxis` (= .z, the walker's break-early
// bound). bbox.js already exports segBboxInto, the TIGHT curve bbox. Switching
// costs nothing per fragment -- it's all encoder-side -- so the question is only
// how much it would buy.
//
// Two effects, measured here on real SVG content:
//   1. BAND OCCUPANCY. A segment is inserted into every H band its y-range
//      overlaps. A loose y-range puts it in bands it never touches, lengthening
//      the per-fragment walk for BOTH Slug and AAC.
//   2. BREAK-EARLY SLACK. .z = hull xMax >= true xMax, so the walker keeps
//      walking segments that are already entirely left of the cell.

import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePathD } from '../src/svg/path.js';
import { segCtrlBboxInto, segBboxInto } from '../src/svg/bbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// must match svg/buildContext.js exactly
function pickBandsAxis(n) { return Math.max(4, Math.min(96, Math.round(Math.sqrt(Math.max(1, n) * 32)))); }

function analyse(segs, bb) {
  const h = Math.max(1e-6, bb[3] - bb[1]);
  const w = Math.max(1e-6, bb[2] - bb[0]);
  let nx = 0;
  const tight = new Float64Array(4), hull = new Float64Array(4);
  for (const s of segs) { segBboxInto(s, tight, 0); if (tight[3]-tight[1] > h*0.005) nx++; }
  const bandsY = pickBandsAxis(nx || segs.length);

  let hullInserts = 0, tightInserts = 0, ySlack = 0, xSlack = 0, n = 0;
  for (const s of segs) {
    segCtrlBboxInto(s, hull, 0);
    segBboxInto(s, tight, 0);
    // bands whose y-stripe each bbox overlaps
    const band = (bb0, bb1) => {
      const lo = Math.max(0, Math.floor((bb0 - bb[1]) / h * bandsY));
      const hi = Math.min(bandsY - 1, Math.floor((bb1 - bb[1]) / h * bandsY));
      return Math.max(0, hi - lo + 1);
    };
    hullInserts  += band(hull[1], hull[3]);
    tightInserts += band(tight[1], tight[3]);
    ySlack += (hull[3]-hull[1]) - (tight[3]-tight[1]);
    xSlack += hull[2] - tight[2];      // breakAxis slack (hull xMax - true xMax)
    n++;
  }
  return { bandsY, n, hullInserts, tightInserts, ySlack: ySlack/n, xSlack: xSlack/n, w, h };
}

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(path.join(ROOT, 'examples')).filter((f) => f.endsWith('.svg')).slice(0, 60)
      .map((f) => path.join(ROOT, 'examples', f));

// importSvg needs a DOM; pull the path data straight out of the markup instead —
// the encoder consumes exactly what parsePathD returns.
const dAttrs = (svg) => [...svg.matchAll(/\sd\s*=\s*"([^"]+)"/g)].map((m) => m[1]);

let TH = 0, TT = 0, TN = 0;
const rows = [];
for (const f of files) {
  let ds;
  try { ds = dAttrs(readFileSync(f, 'utf8')); } catch { continue; }
  let hI = 0, tI = 0, nn = 0, ys = 0, xs = 0;
  for (const d of ds) {
    let segs;
    try { segs = parsePathD(d); } catch { continue; }
    if (!segs || segs.length < 3) continue;
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    const t = new Float64Array(4);
    for (const s of segs) { segBboxInto(s,t,0); x0=Math.min(x0,t[0]);y0=Math.min(y0,t[1]);x1=Math.max(x1,t[2]);y1=Math.max(y1,t[3]); }
    if (!(x1>x0 && y1>y0)) continue;
    const r = analyse(segs, [x0,y0,x1,y1]);
    hI += r.hullInserts; tI += r.tightInserts; nn += r.n; ys += r.ySlack*r.n; xs += r.xSlack*r.n;
  }
  if (!nn || !hI) continue;
  TH += hI; TT += tI; TN += nn;
  rows.push([path.basename(f), nn, hI, tI, (100*(hI-tI)/hI), ys/nn, xs/nn]);
}

rows.sort((a,b)=>b[4]-a[4]);
console.log('control-hull bbox vs TIGHT curve bbox, per SVG (encoder-side change, free at render time)\n');
console.log('svg                         segs  hullIns  tightIns  band-walk saved  avg y-slack  avg xMax-slack');
console.log('---------------------------------------------------------------------------------------------');
for (const [f,n,hI,tI,pct,ys,xs] of rows.slice(0,14))
  console.log(`${f.slice(0,26).padEnd(26)} ${String(n).padStart(5)} ${String(hI).padStart(8)} ${String(tI).padStart(9)} ${(pct.toFixed(1)+'%').padStart(16)} ${ys.toFixed(3).padStart(12)} ${xs.toFixed(3).padStart(15)}`);
console.log('---------------------------------------------------------------------------------------------');
console.log(`TOTAL over ${rows.length} svgs: ${TN} segs, band inserts ${TH} -> ${TT}  (${(100*(TH-TT)/TH).toFixed(1)}% fewer per-band segment visits)`);
