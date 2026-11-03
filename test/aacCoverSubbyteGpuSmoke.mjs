// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Standalone raw AAC: tiny ordered RGBA8 paints and actual CPU/GPU morphs.
// Groups composite after their constituent paints; no point or mesh routing.
// A draw alpha is group opacity like an authored group: five paints of one byte accumulate (5), then the group fades once (round(5*.8)=4, as group .4 gives round(5*.4)=2).
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  output = process.env.MANTLE_COVER_ALPHA_REPORT;
const roots = {
    ...(process.env.MANTLE_COVER_ALPHA_BASELINE_ROOT
      ? { baseline: path.resolve(process.env.MANTLE_COVER_ALPHA_BASELINE_ROOT) }
      : {}),
    candidate: root,
  },
  hash = (x) => createHash('sha256').update(x).digest('hex');
const sources = (base) => {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return Object.fromEntries(
    walk(base + '/src').map((f) => [path.relative(base, f), hash(readFileSync(f))]),
  );
};
const report = {
  sourceHashes: Object.fromEntries(Object.entries(roots).map(([v, r]) => [v, sources(r)])),
  harnessHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  cache: 'Retained. Untimed actual GPU/CPU morph accuracy, no timing/cold claims.',
  rows: [],
};
const save = () => {
  if (output) writeFileSync(output, JSON.stringify(report) + '\n');
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const [v, ...parts] = decodeURIComponent(u.pathname).slice(1).split('/'),
    base = roots[v],
    f = base && path.resolve(base, parts.join('/'));
  if (!base || !f.startsWith(base + '/') || f.includes('/generated/')) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
};
const cap = capWallTime('aac cover alpha morph', stop, 300000);
console.log(gpuThrottleBanner());
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  report.browser = await browser.version();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  for (const version of Object.keys(roots)) {
    const rows = await page.evaluate(async (version) => {
      const api = await import('/' + version + '/src/index.js'),
        shaders = await api.loadShaders(new URL('/' + version + '/src/shaders/', location.href)),
        out = [];
      (await import('/' + version + '/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
      const paths = {
        line: ['M4 4H28V28H4Z', 'M5 4H29V28H5Z'],
        quad: [
          'M4 4Q16 2 28 4Q30 16 28 28Q16 30 4 28Q2 16 4 4Z',
          'M5 4Q17 2 29 4Q31 16 29 28Q17 30 5 28Q3 16 5 4Z',
        ],
        cubic: [
          'M4 4C10 2 22 2 28 4L28 28C22 30 10 30 4 28Z',
          'M5 4C11 2 23 2 29 4L29 28C23 30 11 30 5 28Z',
        ],
        nativeArc: [
          'M26 16A10 10 0 1 1 6 16A10 10 0 1 1 26 16Z',
          'M27.5 16A10.5 10.5 0 1 1 6.5 16A10.5 10.5 0 1 1 27.5 16Z',
        ],
      };
      // Each drawn program is classified here; its source text never crosses to node.
      const classify = (pair) => ({
        curve: pair.some((s) => /uniform\s+sampler2D\s+uCurveData/.test(s)),
        aac: pair.some((s) => /^\s*#define\s+MANTLE_AAC\s*$/m.test(s)),
        lb: pair.some((s) => /^\s*#define\s+MANTLE_LB_FILL\s*$/m.test(s)),
        paintOnly: pair.some((s) => /^\s*#define\s+MANTLE_COVER_PAINT_ONLY\s*$/m.test(s)),
        lerp: pair.some(
          (s) => s.includes('texelFetch(uA') && s.includes('texelFetch(uB') && s.includes('mix('),
        ),
      });
      const warmWire = async (r, bundle, events, kinds, snap) => {
        for (let i = 0; i < 90; i++) {
          r.prepareBundle(bundle);
          r.prewarmBundle(bundle);
          r.precompileFills();
          const start = events.length;
          await snap('warm');
          const covers = events.slice(start).filter((e) => kinds[e.program].curve);
          if (covers.length && covers.every((e) => kinds[e.program].lb)) return;
          await window.__gpuIdle(3);
        }
        throw Error('Requested unified covers never executed their warmed wire program');
      };
      // These authored paths are entirely inside pixel16,16. Each contributes
      // between half and one alpha byte; ordered RGBA8 OVER rounds every paint.
      const tiny = {
        line: 'M16.25 16.25h.06v.1h-.06z',
        quad: 'M16.25 16.3Q16.28 16.2 16.31 16.3Q16.28 16.4 16.25 16.3Z',
        cubic:
          'M16.31 16.3C16.31 16.32761423749 16.29656854249 16.35 16.28 16.35C16.26343145751 16.35 16.25 16.32761423749 16.25 16.3C16.25 16.27238576251 16.26343145751 16.25 16.28 16.25C16.29656854249 16.25 16.31 16.27238576251 16.31 16.3Z',
        nativeArc: 'M16.31 16.3a.03 .05 0 1 0-.06 0a.03 .05 0 1 0 .06 0z',
      };
      const specs = [
        ...Object.keys(tiny).map((kind) => ({
          kind,
          paints: 5,
          opacity: 0.5,
          expected: [5, 5, 5, 5],
        })),
        { kind: 'line', paints: 5, opacity: 0.5, group: 0.4, expected: [2, 2, 2, 2] },
        { kind: 'line', colors: ['red', 'blue'], opacity: 0.5, expected: [1, 0, 1, 2] },
        { kind: 'line', paints: 5, opacity: 0.25, expected: [0, 0, 0, 0] },
        { kind: 'line', paints: 5, opacity: 0.5, drawAlpha: 0.8, expected: [4, 4, 4, 4] },
      ];
      for (const unified of [false, true])
        for (const spec of specs) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 32;
          const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
          if (!gl) throw Error('WebGL2');
          const dbg = gl.getExtension('WEBGL_debug_renderer_info'),
            device = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          if (/swiftshader|llvmpipe|software/i.test(device))
            throw Error('Physical GPU required ' + device);
          const kinds = {},
            events = [],
            programs = new Map();
          let phase = 'setup';
          for (const key of [
            'drawArrays',
            'drawArraysInstanced',
            'drawElements',
            'drawElementsInstanced',
          ]) {
            const f = gl[key].bind(gl);
            gl[key] = (...args) => {
              const p = gl.getParameter(gl.CURRENT_PROGRAM);
              if (!programs.has(p)) {
                programs.set(p, programs.size + 1);
                kinds[programs.get(p)] = classify(
                  gl.getAttachedShaders(p).map((s) => gl.getShaderSource(s)),
                );
              }
              events.push({ phase, key, args, program: programs.get(p) });
              return f(...args);
            };
          }
          let body = (spec.colors || Array(spec.paints).fill('white'))
            .map(
              (color) =>
                `<path fill="${color}" fill-opacity="${spec.opacity}" d="${tiny[spec.kind]}"/>`,
            )
            .join('');
          if (spec.group) body = `<g opacity="${spec.group}">${body}</g>`;
          const bundle = api.createBundle(
              gl,
              await api.importSvg(
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}<path fill="#2469ae" d="M30 30H31V31H30Z"/></svg>`,
                { preserveViewport: true },
              ),
            ),
            r = api.createRenderer(gl, shaders, {
              aacFill: true,
              aacPoints: false,
              unifiedFill: unified ? 'force' : undefined,
            });
          r.setFillEngine({ route: 'none', kernel: 'aac' });
          r.setViewport(32, 32);
          const snap = async (label) => {
            phase = label;
            r.beginFrame([0, 0, 0, 0]);
            r.drawBundle(bundle, { alpha: spec.drawAlpha ?? 1 });
            r.endFrame();
            if (!(await window.__gpuFence(gl, 30000))) throw Error('GPU fence');
            const px = new Uint8Array(4096);
            gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px);
            if (gl.getError()) throw Error('GL error');
            return Array.from(px);
          };
          if (unified && !spec.group) await warmWire(r, bundle, events, kinds, snap);
          const first = await snap('first');
          await window.__gpuIdle(3);
          const later = await snap('later'),
            restored = await snap('restored'),
            at = ((31 - 16) * 32 + 16) * 4;
          out.push({
            version,
            static: true,
            spec,
            unified,
            device,
            first,
            later,
            restored,
            center: first.slice(at, at + 4),
            events,
            kinds,
            ledger: structuredClone(r.debugStats.engines),
          });
          bundle.dispose();
          r.dispose();
          gl.getExtension('WEBGL_lose_context').loseContext();
        }
      for (const [kind, pair] of Object.entries(paths))
        for (const cpuLerp of [false, true])
          for (const grouped of [false, true])
            for (const t of [0.2, 0.8])
              for (const unified of [false, true]) {
                const cv = document.createElement('canvas');
                cv.width = cv.height = 32;
                const gl = cv.getContext('webgl2', {
                  antialias: false,
                  preserveDrawingBuffer: true,
                });
                const dbg = gl.getExtension('WEBGL_debug_renderer_info'),
                  device = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
                if (/swiftshader|llvmpipe|software/i.test(device))
                  throw Error('Physical GPU required ' + device);
                let phase = 'setup';
                const programs = new Map(),
                  kinds = {},
                  events = [];
                for (const key of [
                  'drawArrays',
                  'drawArraysInstanced',
                  'drawElements',
                  'drawElementsInstanced',
                ]) {
                  const f = gl[key].bind(gl);
                  gl[key] = (...args) => {
                    const p = gl.getParameter(gl.CURRENT_PROGRAM);
                    if (!programs.has(p)) {
                      programs.set(p, programs.size + 1);
                      kinds[programs.get(p)] = classify(
                        gl.getAttachedShaders(p).map((s) => gl.getShaderSource(s)),
                      );
                    }
                    events.push({ phase, key, args, program: programs.get(p) });
                    return f(...args);
                  };
                }
                const make = (i) => {
                  let body = Array.from(
                    { length: 5 },
                    (_, j) =>
                      `<path id="ink${j}" fill="#fff" fill-opacity="${i ? 0.0035 : 0.0025}" d="${pair[i]}"/>`,
                  ).join('');
                  if (grouped) body = `<g id="scope" opacity="${i ? 0.6 : 0.4}">${body}</g>`;
                  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}<path id="marker" fill="#2469ae" d="M30 30H31V31H30Z"/></svg>`;
                };
                const a = api.createBundle(
                    gl,
                    await api.importSvg(make(0), { preserveViewport: true }),
                  ),
                  b = api.createBundle(
                    gl,
                    await api.importSvg(make(1), { preserveViewport: true }),
                  );
                const morph = api.createShapeMorph(gl, a, b, { cpuLerp });
                if (!cpuLerp) morph.bundle._morphSrc.gpuSmallPlanes = true;
                phase = 'pose';
                morph.setT(t);
                const r = api.createRenderer(gl, shaders, {
                  aacFill: true,
                  aacPoints: false,
                  unifiedFill: unified ? 'force' : undefined,
                });
                r.setFillEngine({ route: 'none', kernel: 'aac' });
                r.setViewport(32, 32);
                const snap = async (label) => {
                  phase = label;
                  r.beginFrame([0, 0, 0, 0]);
                  r.drawBundle(morph.bundle);
                  r.endFrame();
                  if (!(await window.__gpuFence(gl, 30000))) throw Error('GPU fence');
                  const px = new Uint8Array(32 * 32 * 4);
                  gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px);
                  const e = gl.getError();
                  if (e) throw Error('GL error ' + e);
                  return Array.from(px);
                };
                if (unified && !grouped) await warmWire(r, morph.bundle, events, kinds, snap);
                const first = await snap('first');
                await window.__gpuIdle(3);
                const later = await snap('later');
                morph.setT(t === 0.2 ? 0.8 : 0.2);
                await snap('other-pose');
                morph.setT(t);
                const restored = await snap('restored');
                const at = ((31 - 16) * 32 + 16) * 4;
                out.push({
                  version,
                  kind,
                  cpuLerp,
                  grouped,
                  t,
                  unified,
                  device,
                  usesGpuCurveLerp: morph.usesGpuCurveLerp,
                  first,
                  later,
                  restored,
                  center: first.slice(at, at + 4),
                  events,
                  kinds,
                  ledger: structuredClone(r.debugStats.engines),
                });
                morph.dispose();
                a.dispose();
                b.dispose();
                r.dispose();
                gl.getExtension('WEBGL_lose_context').loseContext();
              }
      return out;
    }, version);
    report.rows.push(...rows);
    save();
  }
  for (const [v, r] of Object.entries(roots)) assert.deepEqual(sources(r), report.sourceHashes[v]);
  assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), report.harnessHash);
  report.sourceStable = report.harnessStable = true;
  for (const row of report.rows) {
    assert.deepEqual(row.first, row.later);
    assert.deepEqual(row.first, row.restored);
    assert(row.first.some((v) => v));
    const covers = Object.values(row.kinds).filter((k) => k.curve);
    assert(covers.length, 'Actual cover program');
    assert(
      covers.every((k) => k.aac && (!k.lb || k.paintOnly)),
      'Standalone raw AAC program',
    );
    assert(
      !row.events.some((e) => e.key === 'drawArraysInstanced' && e.args[0] === 0),
      'No point route',
    );
    if (row.unified && !(row.static ? row.spec.group : row.grouped)) {
      const visible = row.events.filter(
        (e) => ['first', 'later', 'restored'].includes(e.phase) && row.kinds[e.program].curve,
      );
      assert(
        visible.length && visible.every((e) => row.kinds[e.program].lb),
        'Actual warmed unified draw',
      );
    }
    if (row.static) {
      assert.deepEqual(
        row.center,
        row.version === 'candidate' ? row.spec.expected : [0, 0, 0, 0],
        JSON.stringify(row.spec),
      );
      continue;
    }
    assert.equal(row.usesGpuCurveLerp, !row.cpuLerp);
    if (!row.cpuLerp)
      assert(
        Object.values(row.kinds).some((k) => k.lerp),
        'Executed actual endpoint interpolation program',
      );
    assert(
      !row.events.some((e) => e.key === 'drawArraysInstanced' && e.args[0] === 0),
      'Morph stays on raw covers',
    );
    assert(row.ledger.draws.aac > 0);
    let ink = 0;
    const alpha = 0.0025 + (0.0035 - 0.0025) * row.t;
    for (let i = 0; i < 5; i++) ink = Math.round(255 * alpha + ink * (1 - alpha));
    if (row.grouped) ink = Math.round(ink * (0.4 + (0.6 - 0.4) * row.t));
    const expected = row.version === 'candidate' ? ink : 0;
    assert.deepEqual(
      row.center,
      [expected, expected, expected, expected],
      JSON.stringify({ kind: row.kind, cpu: row.cpuLerp, group: row.grouped, t: row.t }),
    );
  }
  // Both submission layouts must emit the same complete paint, at every pixel.
  const key = (r) =>
    JSON.stringify([
      r.version,
      r.static ?? false,
      r.spec ?? null,
      r.kind ?? null,
      r.cpuLerp ?? null,
      r.grouped ?? null,
      r.t ?? null,
    ]);
  const unified = new Map(report.rows.filter((r) => r.unified).map((r) => [key(r), r]));
  for (const row of report.rows.filter((r) => !r.unified))
    assert.deepEqual(row.first, unified.get(key(row)).first, 'Standalone/unified complete images');
  report.crossRouteImagesExact = true;
  report.finished = new Date().toISOString();
  report.passed = true;
  save();
  console.log('aacCoverSubbyteGpuSmoke PASS');
  console.log(
    JSON.stringify({
      cases: report.rows.length,
      actualGpuMorphs: report.rows.filter((r) => !r.static && !r.cpuLerp).length,
      exactRepeatedAndRestoredImages: true,
      allCurveCentersCorrect: true,
    }),
  );
} catch (e) {
  report.error = e.stack;
  save();
  throw e;
} finally {
  cap.clear();
  await stop();
}
