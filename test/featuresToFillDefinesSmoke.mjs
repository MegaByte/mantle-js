// featuresToFillDefinesSmoke.mjs — featuresToFillDefines() maps an asset
// feature union to the fill-shader omit defines a per-game build compiles with.
// Code-driven scenes (programmatic contours, recolor, setNodeClip) never appear
// in an asset scan, so it omits nothing: every per-game build compiles the same
// full fill shader the dev build runs.
import { featuresToFillDefines } from '../src/shaders/index.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

if (typeof featuresToFillDefines !== 'function') {
  fail('featuresToFillDefines is not exported from shaders');
} else {
  for (const features of [0n, 1n << 4n, (1n << 26n) - 1n]) {
    const defines = featuresToFillDefines(features);
    if (Array.isArray(defines) && defines.length === 0) ok(`features ${features}n omits nothing`);
    else fail(`features ${features}n returned ${JSON.stringify(defines)}`);
  }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
