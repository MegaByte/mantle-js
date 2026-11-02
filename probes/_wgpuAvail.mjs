// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _wgpuAvail — is WebGPU reachable under our puppeteer configs, and on which backend?
import http from 'http';
import { launchBrowser } from '../test/_launch.mjs';
const HTML = `<!DOCTYPE html><html><body><canvas id=c></canvas></body></html>`;
const server = http.createServer((q, s) => {
  s.writeHead(200, { 'content-type': 'text/html' });
  s.end(HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const CFG = {
  'headful, default': { headless: 'new', args: ['--no-sandbox'] },
  'headful, unsafe-webgpu': { headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu'] },
  'headful, metal+unsafe': {
    headless: 'new',
    args: ['--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu'],
  },
  'headless new, unsafe': { headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu'] },
  'headless new, default': { headless: 'new', args: ['--no-sandbox'] },
};
for (const [name, cfg] of Object.entries(CFG)) {
  let br;
  try {
    // HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
    // Renderer) reports and TIMES the same headless or headful.
    // A window is not free to the person running this: macOS CLAMPS --window-position (measured:
    // screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
    // on whichever desktop is in front.
    br = await launchBrowser(cfg);
    const pg = await br.newPage();
    await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    const r = await pg.evaluate(async () => {
      const sec = window.isSecureContext;
      if (!navigator.gpu)
        return `NO navigator.gpu (secureContext=${sec}, ua=${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]})`;
      const a = await navigator.gpu.requestAdapter();
      if (!a) return `NO adapter (secureContext=${sec})`;
      const d = await a.requestDevice().catch(() => null);
      const i = a.info || {};
      const cv = document.getElementById('c').getContext('webgpu');
      return `adapter=${i.vendor || '?'}/${i.architecture || '?'} ${i.description || ''} device=${!!d} canvasCtx=${!!cv} maxStorage=${(a.limits.maxStorageBufferBindingSize / 1048576).toFixed(0)}MB maxWG=${a.limits.maxComputeWorkgroupSizeX}`;
    });
    console.log(`${name.padEnd(24)} → ${r}`);
  } catch (e) {
    console.log(`${name.padEnd(24)} → FAILED: ${e.message.slice(0, 70)}`);
  } finally {
    if (br) await br.close();
  }
}
server.close();
