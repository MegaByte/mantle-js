// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _tigerOrFixture -- examples/tiger.svg when it was fetched (npm run fetch:fixtures), else art made here of the same kind: a 900 x 900 document of
// a few hundred closed cubic outlines, some stroked, some even-odd. A test that wants a lot of real-looking curves runs either way, so it neither
// crashes nor skips in a checkout with no fixtures; a checkout with the tiger keeps testing the tiger.
import { existsSync, readFileSync } from 'fs';

const TIGER = new URL('../examples/tiger.svg', import.meta.url);

function generatedArt() {
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const f = (v) => v.toFixed(3);
  const paths = [];
  for (let s = 0; s < 320; s++) {
    // Half are lumpy outlines of a few strong curves, half smooth ones of many gentle curves (which the analytic build keeps whole).
    const gentle = s % 2 === 1;
    const cx = 60 + 780 * rnd(),
      cy = 60 + 780 * rnd(),
      R = 12 + 48 * rnd(),
      n = gentle ? 16 + Math.floor(16 * rnd()) : 4 + Math.floor(5 * rnd());
    const P = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n,
        r = gentle ? R : R * (0.45 + 0.55 * rnd());
      P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    let d = `M${f(P[0][0])} ${f(P[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p = P[i],
        q = P[(i + 1) % n],
        ex = q[0] - p[0],
        ey = q[1] - p[1];
      const spread = gentle ? 0.1 : 0.9,
        b = (rnd() - 0.35) * spread,
        c = (rnd() - 0.35) * spread;
      const u = 0.2 + 0.2 * rnd(),
        v = 0.6 + 0.2 * rnd(); // not evenly along the chord: that is a graph over it, a cubic with its inflection at infinity
      d += `C${f(p[0] + ex * u + ey * b)} ${f(p[1] + ey * u - ex * b)} ${f(p[0] + ex * v + ey * c)} ${f(p[1] + ey * v - ex * c)} ${f(q[0])} ${f(q[1])}`;
    }
    const color = `rgb(${Math.floor(255 * rnd())},${Math.floor(255 * rnd())},${Math.floor(255 * rnd())})`;
    const rule = s % 5 === 0 ? ' fill-rule="evenodd"' : '';
    const stroke = s % 3 === 0 ? ` stroke="#000" stroke-width="${f(0.5 + 2 * rnd())}"` : '';
    paths.push(`<path d="${d}Z" fill="${color}"${rule}${stroke}/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 900">${paths.join('')}</svg>`;
}

export const tigerIsPresent = () => existsSync(TIGER);

/// The text of the tiger, or of the generated art.
export function tigerOrFixture() {
  if (tigerIsPresent()) return readFileSync(TIGER, 'utf8');
  console.log(
    '  (examples/tiger.svg is absent: running on the generated art; npm run fetch:fixtures fetches the tiger)',
  );
  return generatedArt();
}
