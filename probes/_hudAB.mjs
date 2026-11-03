// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { launchBrowser } from '../test/_launch.mjs';
const PORT = 5174,
  GAME = process.env.GAME || '',
  OUT = 'probes/_hudCaptureOut';
if (!GAME) {
  console.log('SKIP: set GAME to the app page to capture (served on port ' + PORT + ')');
  process.exit(0);
}
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${PORT}/?game=${GAME}&autostart=1`, {
  waitUntil: 'load',
  timeout: 40000,
});
await new Promise((r) => setTimeout(r, 11000)); // question shown + settled (no tap → stays)
await page.screenshot({ path: `${OUT}/iab_lb.png` });
await page.evaluate(() => {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__MANTLE_FORCE_SLUG = true;
});
await new Promise((r) => setTimeout(r, 350));
await page.screenshot({ path: `${OUT}/iab_slug.png` });
console.log('settled same-frame LB + Slug done');
await new Promise((r) => setTimeout(r, 300));
await browser.close();
