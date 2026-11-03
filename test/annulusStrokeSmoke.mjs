// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// annulusStrokeSmoke.mjs — the stroked-circle annulus fast path must be
// INVISIBLE.
//
// A stroked circle is an annulus, whose distance field is closed form, so the
// importer tags the stroke row primKind 4 and the shader skips strokeMinDist's
// band walk. That is only legitimate if it renders what the walk rendered, so
// this pins the output against the walk itself rather than against an eyeball:
// every case is compared to the same geometry drawn through the general path,
// which the test forces by giving the reference a dash pattern of one huge
// on-segment (visually solid, but dashId != 0 disables the fast path).
//
// Also pins the cases that must NOT take it:
//   ellipse            non-uniform scale — offsetting an ellipse is not an
//                      ellipse, so squareBB must reject it
//   dashed             the walk owns the arc-length parameter
//   gradient stroke    paint needs per-segment data
//   strokeWidth override  the ring must grow about the same centerline
//
// MANTLE_GPU=1 switches the launch flags. Note that the default flags do NOT
// force software: --enable-unsafe-swiftshader only PERMITS a fallback, so on a
// machine with a working GPU both paths land on it. The banner reports the
// backend actually obtained rather than the one requested.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

// The backend a test REPORTS must be the one it got. MANTLE_GPU only chooses
// launch flags, and --enable-unsafe-swiftshader merely PERMITS a software
// fallback rather than forcing one — on a machine with a working GPU, ANGLE
// takes the GPU anyway. Labeling from the env var would print
// "[SwiftShader]" for runs on a hardware GPU, which is exactly the kind of
// mislabel that gets a real measurement dismissed (or a software one trusted).
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
const SIDE = 300;

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
  let body;
  try {
    body = readFileSync(path.join(ROOT, f));
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': mime(f) });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const USE_GPU = process.env.MANTLE_GPU === '1';
const browser = await launchBrowser({
  headless: 'new',
  args: USE_GPU
    ? ['--use-angle=metal', '--use-gl=angle', '--no-sandbox']
    : ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: SIDE, height: SIDE });
await page.goto(`http://127.0.0.1:${server.address().port}/mantleDemo.html`, {
  waitUntil: 'load',
  timeout: 20000,
});
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 20000,
  polling: 100,
});

const result = await page.evaluate(async (side) => {
  const { importSvg, createBundle, createOverrideTable } = await import('/src/index.js');
  const { parseMetaBin } = await import('/src/core/metaBin.js');
  const META_PRIM_KIND = 44; // texel 11 slot 0 — see svg/meta.js
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  renderer.setViewport(side, side);

  const wrap = (b) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + b + '</svg>';
  const draw = async (svg, opts = {}, mkOverrides = null) => {
    const sections = await importSvg(svg);
    const b = createBundle(gl, sections);
    const h = renderer.createBundleHandle(b);
    let ov = null;
    if (mkOverrides) {
      ov = createOverrideTable(gl, b);
      mkOverrides(ov);
    }
    renderer.beginFrame([1, 1, 1, 1]);
    h.draw(ov ? { ...opts, overrides: ov } : opts);
    renderer.endFrame();
    const buf = new Uint8Array(side * side * 4);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // primKind of every meta row, so the test can prove the path was TAKEN
    // (or not) instead of only that pixels matched.
    // parseMetaBin, NOT a raw Float32Array view: importSvg returns `meta` as
    // packed bytes, and reading it as floats silently yields zeros — which
    // would report "not tagged" for a path that IS tagged and make this whole
    // test vacuous in the reassuring direction.
    const kinds = [];
    const stride = sections.metaFloatsPerShape | 0;
    const parsed = parseMetaBin(sections.meta, stride);
    const m = parsed.metaFloats;
    const n = sections.numShapes | 0;
    for (let i = 0; i < n; i++) kinds.push(Math.round(m[i * stride + META_PRIM_KIND]));
    h.dispose();
    b.dispose();
    if (ov) ov.dispose();
    return { buf, kinds };
  };
  const diff = (a, b) => {
    let n = 0,
      max = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
      );
      if (d > 1) n++;
      if (d > max) max = d;
    }
    return { n, max };
  };
  const ink = (a) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] < 245 || a[i + 1] < 245 || a[i + 2] < 245) n++;
    return n;
  };

  const out = {};
  // A dash whose ON segment dwarfs the circumference is visually solid, but
  // dashId != 0 forces the general walk — so this is the same geometry through
  // the path the fast one replaces.
  const circle = (extra) =>
    wrap(
      `<circle cx="50" cy="50" r="34" fill="none" ` + `stroke="#c33" stroke-width="9" ${extra}/>`,
    );

  for (const [name, w] of [
    ['w9', 9],
    ['w2', 2],
    ['w20', 20],
  ]) {
    const fast = await draw(
      wrap(`<circle cx="50" cy="50" r="34" fill="none" stroke="#c33" stroke-width="${w}"/>`),
    );
    const ref = await draw(
      wrap(
        `<circle cx="50" cy="50" r="34" fill="none" stroke="#c33" ` +
          `stroke-width="${w}" stroke-dasharray="10000 0"/>`,
      ),
    );
    out[name] = {
      ...diff(fast.buf, ref.buf),
      ink: ink(fast.buf),
      kinds: fast.kinds,
      refKinds: ref.kinds,
    };
  }

  // Filled AND stroked: the fill row keeps primKind 1, the stroke row gets 4.
  {
    const fast = await draw(
      wrap('<circle cx="50" cy="50" r="34" fill="#39f" stroke="#c33" stroke-width="9"/>'),
    );
    const ref = await draw(
      wrap(
        '<circle cx="50" cy="50" r="34" fill="#39f" stroke="#c33" ' +
          'stroke-width="9" stroke-dasharray="10000 0"/>',
      ),
    );
    out.fillAndStroke = { ...diff(fast.buf, ref.buf), ink: ink(fast.buf), kinds: fast.kinds };
  }

  // strokeWidth OVERRIDE: the ring must grow about the same centerline, which
  // is why the radius is derived from the AUTHORED width, not the live one.
  {
    const fast = await draw(
      wrap('<circle id="c" cx="50" cy="50" r="34" fill="none" stroke="#c33" stroke-width="9"/>'),
      {},
      (ov) => ov.update(0, { strokeWidth: 16 }),
    );
    const ref = await draw(
      wrap(
        '<circle id="c" cx="50" cy="50" r="34" fill="none" stroke="#c33" ' +
          'stroke-width="9" stroke-dasharray="10000 0"/>',
      ),
      {},
      (ov) => ov.update(0, { strokeWidth: 16 }),
    );
    out.widthOverride = { ...diff(fast.buf, ref.buf), ink: ink(fast.buf) };
  }

  // Must NOT take the fast path.
  {
    const ell = await draw(
      wrap('<ellipse cx="50" cy="50" rx="40" ry="22" fill="none" stroke="#c33" stroke-width="9"/>'),
    );
    const dash = await draw(
      wrap(
        '<circle cx="50" cy="50" r="34" fill="none" stroke="#c33" stroke-width="9" stroke-dasharray="8 6"/>',
      ),
    );
    const grad = await draw(
      wrap(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
          '<stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
          '<circle cx="50" cy="50" r="34" fill="none" stroke="url(#g)" stroke-width="9"/>',
      ),
    );
    out.ellipseKinds = ell.kinds;
    out.ellipseInk = ink(ell.buf);
    out.dashInk = ink(dash.buf);
    out.gradKinds = grad.kinds;
    out.gradInk = ink(grad.buf);
  }
  void circle;
  return out;
}, SIDE);

const BACKEND = await backendOf(page);
await browser.close();
server.close();

const tol = (r, label) => {
  if (!r.ink || r.ink < 500) {
    fail(`${label}: reference drew almost nothing (ink ${r.ink}) — vacuous`);
    return;
  }
  // Closed form vs band walk: both analytic, so only AA-edge rounding differs.
  if (r.n <= r.ink * 0.02 && r.max <= 24)
    ok(`${label} matches the band walk (${r.n}px differ, max ${r.max})`);
  else
    fail(
      `${label} DIFFERS from the band walk: ${r.n}px (${((r.n / r.ink) * 100).toFixed(1)}% of ink), max ${r.max}`,
    );
};

for (const k of ['w9', 'w2', 'w20']) tol(result[k], `stroked circle ${k}`);
tol(result.fillAndStroke, 'filled + stroked circle');
tol(result.widthOverride, 'strokeWidth override');

if (result.w9.kinds && result.w9.kinds.includes(4))
  ok('stroke row is tagged primKind 4 (fast path reachable)');
else
  fail(
    `stroke row NOT tagged: kinds=${JSON.stringify(result.w9.kinds)} — the test would be vacuous`,
  );
// The reference is tagged too, and SHOULD be: tagging is geometric (done at
// import), while the fallback is a RUNTIME gate on dashId. That is what makes
// it a clean control — byte-identical geometry and tagging, differing only in
// which branch the shader takes. Asserting it untagged would assert the wrong
// design.
if (result.w9.refKinds && result.w9.refKinds.includes(4))
  ok('the reference shares geometry AND tagging, and is diverted by dashId alone');
else fail(`the reference is not the same shape (${JSON.stringify(result.w9.refKinds)})`);

if (
  result.fillAndStroke.kinds &&
  result.fillAndStroke.kinds.includes(1) &&
  result.fillAndStroke.kinds.includes(4)
)
  ok('fill row keeps primKind 1 while the stroke row takes 4');
else fail(`fill+stroke tagging wrong: ${JSON.stringify(result.fillAndStroke.kinds)}`);

if (result.ellipseKinds && !result.ellipseKinds.includes(4))
  ok('an ellipse is not tagged as an annulus');
else fail(`ellipse tagged primKind 4: ${JSON.stringify(result.ellipseKinds)}`);
if (result.ellipseInk > 500) ok(`ellipse still renders (${result.ellipseInk}px)`);
else fail('ellipse rendered nothing');
if (result.dashInk > 500) ok(`dashed circle still renders (${result.dashInk}px)`);
else fail('dashed circle rendered nothing');
if (result.gradKinds && !result.gradKinds.includes(4)) ok('a gradient stroke is not tagged');
else fail(`gradient stroke tagged: ${JSON.stringify(result.gradKinds)}`);
if (result.gradInk > 500) ok(`gradient stroke still renders (${result.gradInk}px)`);
else fail('gradient stroke rendered nothing');

console.log();
console.log(
  `${failures === 0 ? 'ANNULUS-STROKE PASS' : `ANNULUS-STROKE FAIL (${failures})`}` +
    ` [${BACKEND}]`,
);
process.exit(failures === 0 ? 0 : 1);
