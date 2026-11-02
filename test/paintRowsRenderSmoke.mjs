// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintRowsRenderSmoke -- radial focal radius, singular paint transforms and pattern stroke paints, against Chrome's own rendering of the same SVG (test/_chromeRef.mjs):
//   radialGradient `fr` (the general two-circle gradient; fr > r not clamped; repeat/reflect/pad; userSpaceOnUse; gradientTransform; stop alpha)
//   a singular gradientTransform / patternTransform paints the url() fallback, else nothing
//   a vector pattern as a STROKE paint (the pattern masked by the stroked outline), alone and with fill, paint-order, mask, clip, filter,
//          opacity, blend
// A pixel is compared only where Chrome's 3x3 neighborhood changes by no more than `edge` (a HARD edge -- a shape border, a cone rim, a dash end --
// is the 8x box-averaged convention's business, not this smoke's), and must be within `tol` per channel.
import { launchBrowser } from './_launch.mjs';
import { openChromeRef } from './_chromeRef.mjs';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const W = 64,
  H = 64;
const doc = (b) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${b}</svg>`;
const RG = (attrs, spread = '') =>
  `<radialGradient id="g" ${attrs} ${spread}><stop offset="0" stop-color="#f00"/><stop offset=".5" stop-color="#ff0"/><stop offset="1" stop-color="#00f"/></radialGradient>`;
const GR = (paint = 'url(#g)') => `<rect x="4" y="4" width="56" height="56" fill="${paint}"/>`;
const LG = (attrs) =>
  `<linearGradient id="g" ${attrs}><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>`;
const PAT = (attrs = '') =>
  `<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse" ${attrs}><rect width="4" height="8" fill="#0a0"/><rect x="4" width="4" height="8" fill="#a0a"/></pattern>`;
const BOX = (paint, extra = '') =>
  `<rect x="8" y="8" width="48" height="48" fill="${paint}" ${extra}/>`;
const SQ = (stroke = 'url(#p)', extra = '', shape = '<rect x="14" y="14" width="36" height="36"') =>
  `${shape} fill="none" stroke="${stroke}" stroke-width="12" ${extra}/>`;

const CELLS = [
  { name: 'fr .2', svg: doc(`<defs>${RG('fr=".2"')}</defs>${GR()}`), edge: 48, tol: 3 },
  { name: 'fr .4', svg: doc(`<defs>${RG('fr=".4"')}</defs>${GR()}`), edge: 48, tol: 3 },
  {
    name: 'fr 20% (same as .2)',
    svg: doc(`<defs>${RG('fr="20%"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  { name: 'fr > r (.7 vs .5)', svg: doc(`<defs>${RG('fr=".7"')}</defs>${GR()}`), edge: 48, tol: 3 },
  {
    name: 'fr == r (hard ring)',
    svg: doc(`<defs>${RG('fr=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr with the focus inside',
    svg: doc(`<defs>${RG('fr=".15" fx=".4" fy=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr with a cone (focus outside)',
    svg: doc(`<defs>${RG('fr=".1" fx=".9" fy=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr, focus on the rim',
    svg: doc(`<defs>${RG('fr=".3" fx=".95" fy=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr reflect',
    svg: doc(`<defs>${RG('fr=".2" r=".3"', 'spreadMethod="reflect"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr repeat (seams below 0)',
    svg: doc(`<defs>${RG('fr=".2" r=".3"', 'spreadMethod="repeat"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr userSpaceOnUse',
    svg: doc(
      `<defs>${RG('gradientUnits="userSpaceOnUse" cx="32" cy="32" r="28" fx="20" fy="32" fr="8"')}</defs>${GR()}`,
    ),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr + gradientTransform',
    svg: doc(
      `<defs>${RG('fr=".2" gradientTransform="rotate(30 .5 .5) scale(1 .6)"')}</defs>${GR()}`,
    ),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr through href, on a stroke',
    svg: doc(
      `<defs>${RG('fr=".2"')}<radialGradient id="h" href="#g"/></defs><rect x="12" y="12" width="40" height="40" fill="none" stroke="url(#h)" stroke-width="12"/>`,
    ),
    edge: 48,
    tol: 3,
  },
  {
    name: 'negative fr reads as 0',
    svg: doc(`<defs>${RG('fr="-.2"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'gradientTransform scale(0): nothing',
    svg: doc(`<defs>${LG('gradientTransform="scale(0)"')}</defs>${BOX('url(#g)')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'singular matrix + fallback',
    svg: doc(`<defs>${LG('gradientTransform="matrix(1 2 2 4 0 0)"')}</defs>${BOX('url(#g) lime')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'radial singular on a stroke',
    svg: doc(`<defs>${RG('gradientTransform="scale(0)"')}</defs>${SQ('url(#g)')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'patternTransform scale(0): nothing',
    svg: doc(`<defs>${PAT('patternTransform="scale(0)"')}</defs>${BOX('url(#p)')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'patternTransform singular + fallback',
    svg: doc(`<defs>${PAT('patternTransform="matrix(1 2 2 4 0 0)"')}</defs>${BOX('url(#p) lime')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'control: gradientTransform scale(1e-6) paints',
    svg: doc(`<defs>${LG('gradientTransform="scale(1e-6)"')}</defs>${BOX('url(#g)')}`),
    edge: 2,
    tol: 2,
  },
  { name: 'rect stroke pattern', svg: doc(`<defs>${PAT()}</defs>${SQ()}`), edge: 2, tol: 3 },
  {
    name: 'circle stroke pattern',
    svg: doc(`<defs>${PAT()}</defs>${SQ('url(#p)', '', '<circle cx="32" cy="32" r="20"')}`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'pattern fill and stroke',
    svg: doc(
      `<defs>${PAT()}</defs><rect x="14" y="14" width="36" height="36" fill="url(#p)" stroke="url(#p)" stroke-width="12"/>`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'solid fill, paint-order stroke',
    svg: doc(
      `<defs>${PAT()}</defs><rect x="14" y="14" width="36" height="36" fill="#ccc" stroke="url(#p)" stroke-width="12" paint-order="stroke"/>`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'stroke-opacity .5',
    svg: doc(`<defs>${PAT()}</defs>${SQ('url(#p)', 'stroke-opacity=".5"')}`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'round join and caps',
    svg: doc(
      `<defs>${PAT()}</defs><polyline points="10,50 32,14 54,50" fill="none" stroke="url(#p)" stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/>`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'patternTransform scale',
    svg: doc(`<defs>${PAT('patternTransform="scale(2)"')}</defs>${SQ()}`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'element transform',
    svg: doc(`<defs>${PAT()}</defs><g transform="translate(6 4) rotate(10 32 32)">${SQ()}</g>`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'clip-path on the element',
    svg: doc(
      `<defs>${PAT()}<clipPath id="c"><rect width="32" height="64"/></clipPath></defs>${SQ('url(#p)', 'clip-path="url(#c)"')}`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'gray mask on the element',
    svg: doc(
      `<defs>${PAT()}<mask id="m"><rect width="64" height="64" fill="#808080"/></mask></defs>${SQ('url(#p)', 'mask="url(#m)"')}`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'multiply blend',
    svg: doc(
      `<defs>${PAT()}</defs><rect width="64" height="64" fill="#ff0"/>${SQ('url(#p)', 'style="mix-blend-mode:multiply"')}`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'inside a group with opacity',
    svg: doc(`<defs>${PAT()}</defs><g opacity=".5">${SQ()}</g>`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'empty pattern + fallback',
    svg: doc(
      `<defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"/></defs>${SQ('url(#p) lime')}`,
    ),
    edge: 2,
    tol: 3,
  },
];

const ref = await openChromeRef(launchBrowser);
try {
  for (const c of CELLS) {
    const { mantle, chrome } = await ref.render(c.svg, { w: W, h: H, ground: 'white' });
    let max = 0,
      n = 0,
      at = '';
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i0 = (y * W + x) * 4;
        let flat = true;
        for (let dy = -1; dy <= 1 && flat; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const j =
              (Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))) * 4;
            for (let k = 0; k < 4; k++)
              if (Math.abs(chrome[j + k] - chrome[i0 + k]) > c.edge) {
                flat = false;
                break;
              }
            if (!flat) break;
          }
        if (!flat) continue;
        n++;
        for (let k = 0; k < 4; k++) {
          const d = Math.abs(mantle[i0 + k] - chrome[i0 + k]);
          if (d > max) {
            max = d;
            at = `(${x},${y}) mantle [${Array.from(mantle.slice(i0, i0 + 4))}] chrome [${Array.from(chrome.slice(i0, i0 + 4))}]`;
          }
        }
      }
    const msg = `${c.name}: ${n} px compared, max ${max}${max > c.tol ? ' at ' + at : ''}`;
    if (n < 200) fail(msg + ' -- too few pixels compared');
    else if (max <= c.tol) ok(msg);
    else fail(msg);
  }
  for (const e of ref.pageErrors) fail('page: ' + e);
} catch (e) {
  fail('setup: ' + e.message);
}
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\npaintRowsRenderSmoke: fr, singular paint transforms and pattern strokes match Chrome',
);
