// gradientStopsPackSmoke.mjs — verify the exact-stop packing. Imports the REAL
// packGradientStops (ESM) so it can't drift from the deployed packer.
//
// Layout: TWO RGBA8 texels per stop (8 bytes):
//   texel A = (R, G, B, alpha)   STRAIGHT (non-premultiplied) color
//   texel B = (offset, 0, 0, 0)  stop position, 8-bit
// Straight color + real alpha is what lets per-stop alpha reach the composited
// output (the shader premultiplies after sampling).
import { packGradientStops } from '../src/svg/gradient.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else       { console.log('ok:', msg); }
}
// Per-stop accessors into the packed byte array.
const colA = (p, i) => [p[i * 8], p[i * 8 + 1], p[i * 8 + 2], p[i * 8 + 3]]; // R,G,B,alpha
const off  = (p, i) => p[i * 8 + 4];                                          // offset byte
const stops = (p) => p.length / 8;

// === 1: 2-stop opaque red→blue, straight color, offset in texel B =====
{
  const p = packGradientStops({ stops: [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 0, 1, 1] },
  ]});
  assert(p.length === 16, `2-stop pack → 16 bytes (2 texels each), got ${p.length}`);
  assert(String(colA(p, 0)) === String([255, 0, 0, 255]), `stop[0] straight RGBA = (255,0,0,255), got (${colA(p,0)})`);
  assert(off(p, 0) === 0,   `stop[0] offset = 0, got ${off(p,0)}`);
  assert(String(colA(p, 1)) === String([0, 0, 255, 255]), `stop[1] straight RGBA = (0,0,255,255), got (${colA(p,1)})`);
  assert(off(p, 1) === 255, `stop[1] offset = 255, got ${off(p,1)}`);
}

// === 2: non-canonical-range stops get sentinel-padded to [0..1] =======
{
  const p = packGradientStops({ stops: [
    { offset: 0.25, color: [1, 0, 0, 1] },
    { offset: 0.75, color: [0, 1, 0, 1] },
  ]});
  assert(stops(p) === 4, `padded to [0, 0.25, 0.75, 1] = 4 stops, got ${stops(p)}`);
  assert(off(p, 0) === 0 && off(p, 3) === 255, `sentinel offsets 0 and 1.0, got ${off(p,0)}/${off(p,3)}`);
  assert(colA(p, 0)[0] === 255 && colA(p, 1)[0] === 255, 'sentinel stop[0] copies first stop color (red)');
}

// === 3: unsorted input is sorted =====================================
{
  const p = packGradientStops({ stops: [
    { offset: 1, color: [0, 0, 1, 1] },
    { offset: 0, color: [1, 0, 0, 1] },
  ]});
  assert(stops(p) === 2 && colA(p, 0)[0] === 255, 'unsorted input sorted → first stop red');
}

// === 4: alpha is STRAIGHT (not premultiplied) ========================
{
  // Half-alpha green: straight color (0,255,0) with alpha round(0.5*255)=128.
  // g stays 255 (not premultiplied), alpha = 128.
  const p = packGradientStops({ stops: [
    { offset: 0, color: [0, 1, 0, 0.5] },
    { offset: 1, color: [0, 1, 0, 0.5] },
  ]});
  assert(colA(p, 0)[1] === 255, `straight green stays 255 (not premult), got ${colA(p,0)[1]}`);
  assert(colA(p, 0)[3] === 128, `per-stop alpha preserved = 128, got ${colA(p,0)[3]}`);
  assert(off(p, 0) === 0, `offset lives in texel B, got ${off(p,0)}`);
}

// === 5: empty stops → transparent-black fallback =====================
{
  const p = packGradientStops({});
  assert(stops(p) === 2, `no-stops fallback → 2 stops, got ${stops(p)}`);
  assert(String(colA(p, 0)) === String([0, 0, 0, 0]), 'fallback stop[0] = transparent black (straight)');
  assert(off(p, 0) === 0 && off(p, 1) === 255, 'fallback offsets 0 and 1.0');
}

// === 6: cap is 256, not 32 ===========================================
{
  const s40 = []; for (let i = 0; i < 40; i++) s40.push({ offset: i / 39, color: [i / 40, 0, 0, 1] });
  assert(stops(packGradientStops({ stops: s40 })) === 40, `40 stops pass through uncapped, got ${stops(packGradientStops({ stops: s40 }))}`);
  const s300 = []; for (let i = 0; i < 300; i++) s300.push({ offset: i / 299, color: [i / 300, 0, 0, 1] });
  assert(stops(packGradientStops({ stops: s300 })) === 256, `>256 stops capped to 256, got ${stops(packGradientStops({ stops: s300 }))}`);
}

// === 7: exact-stop offsets (1/255 resolution, no 256-bin ramp) ========
{
  const p = packGradientStops({ stops: [
    { offset: 0,       color: [0, 0, 0, 1] },
    { offset: 1 / 512, color: [1, 0, 0, 1] },
    { offset: 1,       color: [0, 0, 0, 1] },
  ]});
  assert(stops(p) === 3, `3-stop pack = 3 stops, got ${stops(p)}`);
  // 1/512 → round(255/512) = 0 in the 8-bit offset field (documented residual).
  assert(off(p, 1) === 0,   `1/512 offset → 1/255 quantized to 0, got ${off(p,1)}`);
  assert(off(p, 2) === 255, `1.0 offset → 255, got ${off(p,2)}`);
}

// === 8: opaque fast path (oneTexel=true) → 1 RGBA8 texel/stop ==========
{
  // Same red→blue stops as case 1, but packed for the all-opaque fast path:
  // ONE texel/stop holding (R, G, B, offset). Alpha is implicit 1.
  const p = packGradientStops({ stops: [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 0, 1, 1] },
  ]}, /* oneTexel */ true);
  assert(p.length === 8, `2-stop opaque pack → 8 bytes (1 texel each), got ${p.length}`);
  // texel i = [R, G, B, offset]
  assert(String([p[0], p[1], p[2]]) === String([255, 0, 0]), `stop[0] rgb = (255,0,0), got (${[p[0],p[1],p[2]]})`);
  assert(p[3] === 0,   `stop[0] offset in .a = 0, got ${p[3]}`);
  assert(String([p[4], p[5], p[6]]) === String([0, 0, 255]), `stop[1] rgb = (0,0,255), got (${[p[4],p[5],p[6]]})`);
  assert(p[7] === 255, `stop[1] offset in .a = 255, got ${p[7]}`);
}

console.log('---');
if (failures) console.error(`GRADIENT-STOPS-PACK FAIL (${failures})`);
else          console.log('GRADIENT-STOPS-PACK PASS');
process.exit(failures ? 1 : 0);
