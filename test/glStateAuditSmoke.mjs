// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// glStateAuditSmoke.mjs — prove renderer/glState.js's pipeline-state shadow
// never diverges from the driver.
//
// The shadow lets a pass declare the state it needs without paying for a GL
// call when the value is already set. It is sound only while every writer goes
// through it (or bumps core/glEpoch). This drives a deliberately broad set of
// features — plain fill, stroke, gradient, clip, mask, filter, image,
// Loop-Blinn, instancing, static cache, a scissor rect, and a GPU shape morph
// (a public entry point that writes state with the consumer's own gl) — with
// `auditGlState` on, so every set reads the driver back. It then audits once
// more after each frame. Any writer that bypassed the shadow shows up as a
// mismatch naming the state it desynced.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

// The backend a test REPORTS must be the one it got. MANTLE_GPU only chooses
// launch flags, and --enable-unsafe-swiftshader merely PERMITS a software
// fallback rather than forcing one — on a machine with a working GPU, ANGLE
// takes the GPU anyway. Labeling from the env var would print "[SwiftShader]"
// for runs on a hardware GPU, the kind of mislabel that gets a real
// measurement dismissed (or a software one trusted).
const backendOf = async (pg) => {
  try {
    return await pg.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return 'no webgl2';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      const r = String(
        d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      );
      return /swiftshader|software|llvmpipe/i.test(r)
        ? 'SwiftShader'
        : r.replace(/^ANGLE \(|\)$/g, '');
    });
  } catch {
    return 'unknown';
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript; charset=utf-8'
      : p.endsWith('.glsl')
        ? 'text/plain; charset=utf-8'
        : 'application/octet-stream';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const f = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(f) });
    res.end(readFileSync(path.join(ROOT, f)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {
      /* client gone */
    }
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// MANTLE_GPU=1 switches the launch flags. The default flags do NOT force
// software — --enable-unsafe-swiftshader only PERMITS a fallback — so on a
// machine with a working GPU both paths land on it; the banner reports the
// backend actually obtained.
// Worth doing for a state audit specifically: SwiftShader is a different
// driver, and "the shadow matches" is a claim about a driver.
const USE_GPU = process.env.MANTLE_GPU === '1';
const browser = await launchBrowser({
  headless: 'new',
  args: USE_GPU
    ? ['--use-angle=metal', '--use-gl=angle', '--no-sandbox']
    : ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 240, height: 240 });
await page.goto(`http://127.0.0.1:${server.address().port}/mantleDemo.html`, {
  waitUntil: 'load',
  timeout: 15000,
});
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 15000,
  polling: 100,
});

const result = await page.evaluate(async () => {
  const mantle = await import('/src/index.js');
  const { importSvg, createBundle, createOverrideTable, setDiagnostics, createShapeMorph } = mantle;
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const R = renderer._R || null; // not exposed; audit through the renderer below

  const SOLID =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path fill="#c33" d="M 10 50 C 10 10 90 10 90 50 C 90 90 10 90 10 50 Z"/></svg>';
  const STROKED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<rect x="15" y="15" width="70" height="70" fill="#3c3" stroke="#000" stroke-width="7"/></svg>';
  const GRADIENT =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
    '<circle cx="50" cy="50" r="40" fill="url(#g)"/></svg>';
  const CLIPPED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<defs><clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath></defs>' +
    '<rect x="0" y="0" width="100" height="100" fill="#39f" clip-path="url(#c)"/></svg>';
  const MASKED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<defs><mask id="m"><rect x="0" y="0" width="60" height="100" fill="#fff"/></mask></defs>' +
    '<rect x="0" y="0" width="100" height="100" fill="#f93" mask="url(#m)"/></svg>';
  const FILTERED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<defs><filter id="b"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
    '<rect x="20" y="20" width="60" height="60" fill="#93f" filter="url(#b)"/></svg>';
  const BLUE_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQ0TjxHwADXAIEAtgdbwAAAABJRU5ErkJggg==';
  const IMAGE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    `<image href="${BLUE_PNG}" x="10" y="10" width="80" height="80"/></svg>`;
  const MORPH_A =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path id="p" fill="#c33" d="M 10 10 L 90 10 L 90 90 L 10 90 Z"/></svg>';
  const MORPH_B =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path id="p" fill="#33c" d="M 30 20 L 80 30 L 70 80 L 20 70 Z"/></svg>';

  const mk = async (svg) => createBundle(gl, await importSvg(svg));
  const solid = await mk(SOLID),
    stroked = await mk(STROKED),
    grad = await mk(GRADIENT);
  const clipped = await mk(CLIPPED),
    masked = await mk(MASKED),
    filtered = await mk(FILTERED);
  const image = await mk(IMAGE);
  const morphA = await mk(MORPH_A),
    morphB = await mk(MORPH_B);

  // Audit through the public surface: the renderer exposes glAuditState on its
  // internal context, reachable via the diagnostics hook the module installs.
  const audit = () => (renderer.__glAuditState ? renderer.__glAuditState() : []);

  setDiagnostics({ auditGlState: true });

  const all = [];
  const wm = (tx, ty, s) => new Float32Array([s, 0, 0, 0, s, 0, tx, ty, 1]);

  const cachedHandle = renderer.createBundleHandle(solid, {
    staticCache: { strategy: mantle.CacheStrategy.ForceWholeAsset },
  });
  const lbHandle = renderer.createBundleHandle(grad, { engine: 'lb' });
  const overrides = createOverrideTable(gl, solid);
  overrides.set(0, { fill: [0, 1, 0, 1] });
  let morph = null;
  try {
    morph = createShapeMorph(gl, morphA, morphB);
  } catch {
    morph = null;
  }

  for (let frame = 0; frame < 6; frame++) {
    renderer.beginFrame([1, 1, 1, 1]);
    renderer.drawBundle(solid, { worldMatrix: wm(-0.6, 0.6, 0.3) });
    renderer.drawBundle(stroked, { worldMatrix: wm(0, 0.6, 0.3) });
    renderer.drawBundle(grad, { worldMatrix: wm(0.6, 0.6, 0.3) });
    renderer.drawBundle(clipped, { worldMatrix: wm(-0.6, 0, 0.3) });
    renderer.drawBundle(masked, { worldMatrix: wm(0, 0, 0.3) });
    renderer.drawBundle(filtered, { worldMatrix: wm(0.6, 0, 0.3) });
    renderer.drawBundle(image, { worldMatrix: wm(-0.6, -0.6, 0.3) });
    renderer.drawBundle(solid, { worldMatrix: wm(0, -0.6, 0.3), overrides });
    renderer.drawBundleInstanced(solid, [
      { worldMatrix: wm(0.4, -0.6, 0.15) },
      { worldMatrix: wm(0.7, -0.6, 0.15) },
    ]);
    lbHandle.draw({ worldMatrix: wm(0.3, 0.3, 0.2), engine: 'lb' });
    cachedHandle.draw({ worldMatrix: wm(-0.3, -0.3, 0.2) });
    if (morph) {
      try {
        morph.setT((frame % 5) / 4);
      } catch {
        /* morph unsupported here */
      }
    }
    renderer.setScissorRect(10, 10, 200, 200);
    renderer.drawBundle(solid, { worldMatrix: wm(0.2, 0.2, 0.2) });
    renderer.clearScissorRect();
    renderer.endFrame();
    all.push(...audit());
  }

  // TWO RENDERERS, ONE CONTEXT. GL state is per-context, so a per-renderer
  // shadow would have each believe its own last write still stood after the
  // other overwrote it. Engine-comparison harnesses do exactly this.
  let secondRendererMismatches = ['second renderer not built'];
  try {
    const { createRenderer, loadShaders } = mantle;
    const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
    const r2 = createRenderer(gl, shaders, {});
    if (r2 && typeof r2.then === 'function') await r2;
    const other = r2 && typeof r2.then === 'function' ? await r2 : r2;
    other.setViewport(240, 240);
    for (let i = 0; i < 3; i++) {
      other.beginFrame([1, 1, 1, 1]);
      other.drawBundle(stroked, { worldMatrix: wm(0, 0, 0.4) });
      other.endFrame();
      renderer.beginFrame([1, 1, 1, 1]);
      renderer.drawBundle(grad, { worldMatrix: wm(0, 0, 0.4) });
      renderer.endFrame();
    }
    secondRendererMismatches = audit().concat(
      typeof other.__glAuditState === 'function' ? other.__glAuditState() : [],
    );
  } catch (e) {
    secondRendererMismatches = ['second renderer threw: ' + (e && e.message)];
  }

  // Negative control for the TEXTURE-UNIT half of the audit: clobber a fill
  // unit behind the shadow's back (what shapeMorph does to unit 14) and
  // require the audit to name it. Without this the unit check could be inert
  // and every "clean" result above would be meaningless.
  const unitPre = audit();
  const unitCleanBefore = unitPre.length === 0;
  const strayTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + 2); // unit 2 = the meta texture
  gl.bindTexture(gl.TEXTURE_2D, strayTex);
  const unitCaught = audit();
  gl.deleteTexture(strayTex);

  // NEGATIVE CONTROL. An audit that cannot fail proves nothing, so desync the
  // shadow on purpose — write depthMask and disable(BLEND) straight to the
  // driver, behind the tracker's back — and require the audit to name it. Then
  // bump the epoch (what an honest external writer does) and require it to
  // recover.
  //
  // This block runs LAST for a reason: it leaves the shadow deliberately
  // dirty, so any check placed after it inherits a desync it did not cause
  // and would misread it as a renderer bug.
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(solid, { worldMatrix: wm(0, 0, 0.3) });
  renderer.endFrame();
  const cleanBefore = audit().length === 0;
  gl.depthMask(!gl.getParameter(gl.DEPTH_WRITEMASK));
  gl.disable(gl.BLEND);
  const caught = audit();
  const { noteExternalGlWrite } = await import('/src/core/glEpoch.js');
  noteExternalGlWrite();
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(solid, { worldMatrix: wm(0, 0, 0.3) });
  renderer.endFrame();
  const recovered = audit();

  setDiagnostics({ auditGlState: false });
  const px = new Uint8Array(4);
  gl.readPixels(120, 120, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return {
    mismatches: all,
    drew: [...px],
    hasAudit: typeof renderer.__glAuditState === 'function',
    R: !!R,
    cleanBefore,
    caught,
    recovered,
    secondRendererMismatches,
    unitCleanBefore,
    unitCaught,
    unitPre,
  };
});

const BACKEND = await backendOf(page);
await browser.close();
server.close();

if (!result.hasAudit) {
  fail('renderer does not expose __glAuditState — the audit could not run (vacuous test)');
} else {
  ok('audit hook reachable');
  if (result.mismatches.length === 0) {
    ok('GL pipeline-state shadow matched the driver across every feature path');
  } else {
    fail(
      `glState shadow diverged ${result.mismatches.length}×:\n  ` +
        [...new Set(result.mismatches)].slice(0, 12).join('\n  '),
    );
  }
}

if (result.secondRendererMismatches.length === 0) {
  ok('two renderers sharing one context keep one consistent shadow');
} else {
  fail(
    'shadow diverged with a second renderer on the same context: ' +
      result.secondRendererMismatches.slice(0, 6).join('; '),
  );
}

if (!result.unitCleanBefore) {
  fail('texture-unit control started dirty: ' + JSON.stringify(result.unitPre));
} else if (!result.unitCaught || result.unitCaught.length === 0) {
  fail('audit did NOT notice a clobbered fill texture unit — the unit check is vacuous');
} else {
  ok(`audit catches a clobbered texture unit (${result.unitCaught.length} reported)`);
}

// The negative control: the audit must SEE a behind-the-back write, and the
// epoch must clear it. Without both, "no mismatches" above means nothing.
if (!result.cleanBefore) {
  fail('negative control started dirty — cannot attribute the injected mismatch');
} else if (!result.caught || result.caught.length === 0) {
  fail('audit did NOT notice a raw depthMask/disable(BLEND) — the audit is vacuous');
} else {
  ok(`audit catches a behind-the-back write (${result.caught.length} reported)`);
  if (result.recovered.length === 0) ok('noteExternalGlWrite() re-syncs the shadow');
  else fail(`epoch bump did not re-sync: ${result.recovered.join('; ')}`);
}

console.log();
console.log(
  `${failures === 0 ? 'GL-STATE-AUDIT PASS' : `GL-STATE-AUDIT FAIL (${failures})`}` +
    ` [${BACKEND}]`,
);
process.exit(failures === 0 ? 0 : 1);
