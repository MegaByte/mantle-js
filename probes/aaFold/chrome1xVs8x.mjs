// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// chrome1xVs8x.mjs -- paint conflation (d): what does a browser do at 1x? Chrome's own raster of an SVG at N px against Chrome's raster at 8N
// box-averaged 8x8 (the project's AA reference). Chrome's 1x path composites each path's anti-aliased coverage in order, so
// shared edges and stacked paints show the same conflation the engines here do, wherever Skia does not multisample.
//   node probes/aaFold/chrome1xVs8x.mjs --assets a.svg,b.svg --size 512
// Software raster (--disable-gpu): no GPU involved.
import { readFileSync } from 'fs';
import path from 'path';
import { launchBrowser } from '../../test/_launch.mjs';
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const N = +flag('size', 512);
const browser = await launchBrowser({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
for (const file of flag('assets').split(',')) {
  const svg = readFileSync(file, 'utf8');
  const r = await page.evaluate(
    async (svgText, N) => {
      const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      const img = new Image();
      img.src = url;
      await img.decode();
      const nat = { w: img.naturalWidth || 300, h: img.naturalHeight || 150 };
      const draw = (S) => {
        const c = document.createElement('canvas');
        c.width = S;
        c.height = S;
        const x = c.getContext('2d', { willReadFrequently: true });
        const k = Math.min(S / nat.w, S / nat.h),
          w = nat.w * k,
          h = nat.h * k;
        x.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
        return x.getImageData(0, 0, S, S).data;
      };
      const one = draw(N),
        big = draw(8 * N),
        S8 = 8 * N;
      const pm = (d, i) => {
        const a = d[i + 3] / 255;
        return [d[i] * a, d[i + 1] * a, d[i + 2] * a, d[i + 3]];
      };
      let n1 = 0,
        n8 = 0,
        mx = 0,
        edge = 0;
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const acc = [0, 0, 0, 0];
          for (let j = 0; j < 8; j++)
            for (let i = 0; i < 8; i++) {
              const v = pm(big, ((y * 8 + j) * S8 + x * 8 + i) * 4);
              acc[0] += v[0];
              acc[1] += v[1];
              acc[2] += v[2];
              acc[3] += v[3];
            }
          const v1 = pm(one, (y * N + x) * 4);
          let d = 0;
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(v1[k] - acc[k] / 64));
          if (d > 1) {
            n1++;
            if (d > 8) n8++;
            if (d > mx) mx = d;
          }
        }
      URL.revokeObjectURL(url);
      return { n1, n8, mx };
    },
    svg,
    N,
  );
  console.log(
    `${path.basename(file)} @${N}: Chrome 1x vs 8x box reference: px>1B ${r.n1}  px>8B ${r.n8}  max ${r.mx.toFixed(1)}B`,
  );
}
await browser.close();
