// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
import { largeCircleArea } from './_strokeLargeCircleRef.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = {
  ...(process.env.MANTLE_BIG_CIRCLE_BASELINE
    ? { baseline: process.env.MANTLE_BIG_CIRCLE_BASELINE }
    : {}),
  candidate: root,
};
const output = process.env.MANTLE_BIG_CIRCLE_REPORT;
const hash = (x) => createHash('sha256').update(x).digest('hex');
const sourceHashes = (r) => {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return Object.fromEntries(
    walk(r + '/src').map((f) => [path.relative(r, f), hash(readFileSync(f))]),
  );
};
const report = {
  scope:
    'JS isolated four large-circle thresholds, physical GPU helper and actual renderer controls. Retained caches; no cold or throughput claims.',
  started: new Date().toISOString(),
  harnessHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  referenceHash: hash(readFileSync(new URL('./_strokeLargeCircleRef.mjs', import.meta.url))),
  sourceHashes: Object.fromEntries(Object.entries(roots).map(([k, r]) => [k, sourceHashes(r)])),
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
  const [v, ...parts] = decodeURIComponent(u.pathname).slice(1).split('/');
  const r = roots[v],
    p = r && path.resolve(r, parts.join('/'));
  if (!r || !p.startsWith(r + '/') || p.includes('/generated/')) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  server.close();
};
const cap = capWallTime('big circle GPU', stop, 360000);
console.log(gpuThrottleBanner());
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  for (const version of Object.keys(roots)) {
    const result = await page.evaluate(async (version) => {
      const api = await import('/' + version + '/src/index.js');
      const shaders = await api.loadShaders(
        new URL('/' + version + '/src/shaders/', location.href),
      );
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw Error('WebGL2');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info'),
        device = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      if (/swiftshader|llvmpipe|software/i.test(device))
        throw Error('Physical GPU required ' + device);
      if (!gl.getExtension('EXT_color_buffer_float')) throw Error('Float output required');
      const build = (vs, fs) => {
        const ss = [];
        for (const [type, src] of [
          [gl.VERTEX_SHADER, vs],
          [gl.FRAGMENT_SHADER, fs],
        ]) {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
          ss.push(s);
        }
        const p = gl.createProgram();
        for (const s of ss) gl.attachShader(p, s);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
        return p;
      };
      const vert =
        '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
      const FF = shaders.fillFrag.replace('\n', '\n#define MANTLE_STROKE_EXACT\n');
      const at = FF.lastIndexOf('void main()');
      if (at < 0) throw Error('Main missing');
      const frag =
        FF.slice(0, at) +
        `uniform sampler2D uTest;\nvoid main(){int i=int(gl_FragCoord.x);vec4 P=texelFetch(uTest,ivec2(i,0),0),Q=texelFetch(uTest,ivec2(i,1),0),N=texelFetch(uTest,ivec2(i,2),0),H=texelFetch(uTest,ivec2(i,3),0);float c;if(P.w==9.){vec2 hx=strokeFrameMul(N,vec2(.5*H.x,0.)),hy=strokeFrameMul(N,vec2(0.,.5*H.y));float reach=max(length(hx+hy),length(hx-hy)),area=4.*abs(hx.x*hy.y-hx.y*hy.x);c=seCapShare(P.xy,Q.xy,Q.z,hx,hy,reach,area,N,H.xy);}else c=strokeExactCov(P,Q,H.z,N,H.xy);vec2 xx=strokeFrameMul(N,vec2(.5*H.x,0.)),yy=strokeFrameMul(N,vec2(0.,.5*H.y));float rr=max(length(xx+yy),length(xx-yy));vec2 uu=P.w==9.?(length(P.xy)>0.?normalize(P.xy):Q.xy):P.xy;float m=2.*max(abs(dot(uu,xx)),abs(dot(uu,yy)));float ro=P.w==4.?H.z:(P.w==9.?Q.z:Q.x+H.z),ri=P.w==5.?Q.x-H.z:ro;bool bo=ro>4096.*rr||(ro>256.*rr&&rr<=m),bi=ri>4096.*rr||(ri>256.*rr&&rr<=m);fragColor=vec4(c,bo?1.:0.,bi?1.:0.,1.);}`;
      const qs = [];
      for (const scale of [2 ** -20, 1, 2 ** 20])
        for (const R of [20, 100, 181, 250, 500, 1000, 2000, 2800])
          for (const e of [-0.4, 0, 0.27])
            for (const ang of [0.3, 1.1, 2.2])
              for (const kind of ['band', 'sector', 'cap', 'half-cap']) {
                const u = [Math.cos(ang), Math.sin(ang)],
                  D = R + 6 + e,
                  a0 = ang - Math.atan2(0.2, D),
                  n = [-u[1], u[0]];
                const P =
                  kind === 'cap'
                    ? [...u, e * scale, 4]
                    : kind === 'half-cap'
                      ? [u[0] * (R + e) * scale, u[1] * (R + e) * scale, 0, 9]
                      : [...u, e * scale, 5];
                const Q =
                  kind === 'cap'
                    ? [...n, 0, 0]
                    : kind === 'half-cap'
                      ? [...n, R * scale, 0]
                      : [
                          R * scale,
                          D * scale,
                          kind === 'sector' ? a0 : 0,
                          kind === 'sector' ? Math.PI / 2 : 0,
                        ];
                qs.push({
                  kind,
                  R,
                  e,
                  ang,
                  scale,
                  P: P.map(Math.fround),
                  Q: Q.map(Math.fround),
                  N: [1, 0, 0, 1],
                  H: [scale, scale, (kind === 'cap' ? R : 6) * scale, 0],
                });
              }
      for (const scale of [2 ** -20, 1, 2 ** 20])
        for (const N of [
          [1, 0, 0, 1],
          [0.001, 0, 0, 1],
          [1, 0, 0, 0.001],
          [1, 0, 20, 0.01],
          [0.866, 0.5, -0.5, 0.866],
        ])
          for (const R of [181, 250, 1000, 2800])
            for (const e of [-0.0001, 0, 0.0001])
              for (const ang of [0, 0.003, 0.3, Math.PI / 2])
                for (const kind of ['band', 'cap', 'half-cap']) {
                  const u = [Math.cos(ang), Math.sin(ang)],
                    D = R + 6 + e,
                    n = [-u[1], u[0]],
                    P =
                      kind === 'cap'
                        ? [...u, e * scale, 4]
                        : kind === 'half-cap'
                          ? [u[0] * (R + e) * scale, u[1] * (R + e) * scale, 0, 9]
                          : [...u, e * scale, 5],
                    Q =
                      kind === 'cap'
                        ? [...n, 0, 0]
                        : kind === 'half-cap'
                          ? [...n, R * scale, 0]
                          : [R * scale, D * scale, 0, 0];
                  qs.push({
                    kind,
                    R,
                    e,
                    ang,
                    scale,
                    P: P.map(Math.fround),
                    Q: Q.map(Math.fround),
                    N: N.map(Math.fround),
                    H: [scale, scale, (kind === 'cap' ? R : 6) * scale, 0],
                  });
                }
      const W = qs.length,
        p = build(vert, frag);
      gl.useProgram(p);
      const input = new Float32Array(W * 4 * 4);
      for (let i = 0; i < W; i++)
        for (const [row, key] of ['P', 'Q', 'N', 'H'].entries())
          input.set(qs[i][key], (row * W + i) * 4);
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, 4, 0, gl.RGBA, gl.FLOAT, input);
      gl.uniform1i(gl.getUniformLocation(p, 'uTest'), 0);
      const target = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, 1, 0, gl.RGBA, gl.FLOAT, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('FBO');
      gl.viewport(0, 0, W, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const out = new Float32Array(W * 4);
      gl.readPixels(0, 0, W, 1, gl.RGBA, gl.FLOAT, out);
      if (gl.getError()) throw Error('Kernel GL error');
      qs.forEach((q, i) => {
        q.gpu = out[i * 4];
        q.guardOuter = out[i * 4 + 1];
        q.guardInner = out[i * 4 + 2];
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(target);
      gl.deleteTexture(tex);
      gl.deleteProgram(p);
      const actualPrograms = [];
      let active = null;
      const use = gl.useProgram.bind(gl),
        source = new WeakMap(),
        attached = new WeakMap(),
        ss = gl.shaderSource.bind(gl),
        attach = gl.attachShader.bind(gl);
      gl.shaderSource = (s, src) => {
        source.set(s, src);
        return ss(s, src);
      };
      gl.attachShader = (p, s) => {
        if (!attached.has(p)) attached.set(p, []);
        attached.get(p).push(s);
        return attach(p, s);
      };
      gl.useProgram = (p) => {
        active = p;
        return use(p);
      };
      const programs = new Set();
      const calls = [];
      for (const key of [
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
      ]) {
        const draw = gl[key].bind(gl);
        gl[key] = (...args) => {
          if (active) programs.add(active);
          calls.push({ key, args });
          return draw(...args);
        };
      }
      const renderer = api.createRenderer(gl, shaders, {
        aacPoints: false,
        strokeExactEdges: true,
      });
      renderer.setFillEngine({ route: 'none', kernel: 'slug' });
      renderer.setViewport(128, 128);
      const renders = [];
      for (const mode of ['static', 'group', 'morph'])
        for (const scale of [2 ** -20, 1, 2 ** 20])
          for (const R of [100, 250, 1000, 2800])
            for (const kind of ['band', 'sector', 'cap']) {
              if (mode !== 'static' && (scale !== 1 || R !== 1000)) continue;
              const ang =
                  kind === 'sector' ? Math.atan2(0.2, R + 6) : kind === 'cap' ? Math.PI - 0.3 : 0.3,
                hw = kind === 'cap' ? R : 6,
                D = kind === 'cap' ? R + 0.27 : R + 6 + 0.27;
              const center = [64.5 - Math.cos(ang) * D, 64.5 - Math.sin(ang) * D];
              const d =
                kind === 'cap'
                  ? `M0 0 L${R * 4 * scale} 0`
                  : `M${R * scale} 0 A${R * scale} ${R * scale} 0 0 1 0 ${R * scale}`;
              const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-2 * R * scale} ${-2 * R * scale} ${4 * R * scale} ${4 * R * scale}">${mode === 'group' ? '<g opacity=".7">' : ''}<path fill="none" stroke="#2469ae" stroke-opacity=".65" stroke-width="${2 * hw * scale}" stroke-linecap="${kind === 'cap' ? 'round' : 'butt'}" d="${d}"/>${mode === 'group' ? '</g>' : ''}</svg>`;
              const raw = await api.importSvg(svg, { preserveViewport: true }),
                original = api.createBundle(gl, raw),
                morph = mode === 'morph' ? api.createShapeMorph(gl, original, original) : null;
              if (morph) {
                morph.bundle._morphSrc.gpuSmallPlanes = true;
                morph.setT(0.37);
                if (!morph.usesGpuCurveLerp) throw Error('Actual GPU morph required');
              }
              const bundle = morph ? morph.bundle : original;
              const wm = [
                (4 * R) / 128,
                0,
                0,
                0,
                (4 * R) / 128,
                0,
                ((center[0] - 64) * 2) / 128,
                ((64 - center[1]) * 2) / 128,
                1,
              ];
              const draw = async () => {
                renderer.beginFrame([0, 0, 0, 0]);
                renderer.drawBundle(morph || bundle, { worldMatrix: wm });
                renderer.endFrame();
                await window.__gpuFence(gl, 90000);
              };
              await draw();
              await draw();
              const px = new Uint8Array(128 * 128 * 4);
              gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
              if (gl.getError()) throw Error('Renderer GL error');
              if (!px.some((v, i) => i % 4 === 3 && v)) throw Error('Empty ' + kind + ' ' + R);
              const count = calls.length;
              await draw();
              const again = new Uint8Array(px.length);
              gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, again);
              if (again.some((v, i) => v !== px[i])) throw Error('Unstable pixels');
              renders.push({
                mode,
                usesGpuCurveLerp: !!morph?.usesGpuCurveLerp,
                kind,
                R,
                scale,
                hw,
                center,
                wm,
                svg,
                globalBBox: bundle.globalBBox,
                metadata: Array.from(bundle.metaFloats),
                pixels: Array.from(px),
                draws: calls.slice(count),
                ledger: structuredClone(renderer.debugStats.engines),
              });
              if (morph) morph.dispose();
              original.dispose();
            }
      for (const p of programs)
        actualPrograms.push((attached.get(p) || []).map((s) => source.get(s)));
      renderer.dispose();
      gl.getExtension('WEBGL_lose_context').loseContext();
      return {
        device,
        helper: { vertex: vert, fragment: frag, queries: qs },
        actualPrograms,
        renders,
      };
    }, version);
    report.rows.push({ version, ...result });
    save();
    console.log(
      version,
      result.helper.queries.length,
      'helper pixels',
      result.renders.length,
      'actual cases',
    );
  }
  for (const [v, r] of Object.entries(roots))
    assert.deepEqual(sourceHashes(r), report.sourceHashes[v]);
  assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), report.harnessHash);
  assert.equal(
    hash(readFileSync(new URL('./_strokeLargeCircleRef.mjs', import.meta.url))),
    report.referenceHash,
  );
  report.referenceStable = true;
  report.sourceStable = true;
  report.harnessStable = true;
  report.finished = new Date().toISOString();
  save();
  const ref = largeCircleArea(report);
  report.areaSummary = {
    directMax: ref.directMax,
    qualifiedMax: ref.qualifiedMax,
    earlyCases: ref.earlyCases,
    unchangedCases: ref.unchangedCases,
    legacyMaxDifference: ref.legacyMaxDifference,
    directDrift: ref.directDrift,
    renderMax: ref.renderMax,
    renderCases: ref.render.map(({ pixels, ...r }) => ({ ...r, pixelsChecked: pixels.length })),
  };
  if (output) writeFileSync(output + '.area.json', JSON.stringify(ref) + '\n');
  assert(ref.directDrift < 0.05);
  assert(ref.renderMax.drift < 0.05);
  assert(ref.renderMax.candidate <= 1, 'actual translucent renderer within1RGBA byte');
  for (const [k, v] of Object.entries(ref.qualifiedMax))
    if (k.startsWith('candidate')) assert(v <= 1, 'eligible GPU helper within1coverage byte');
  if (roots.baseline) {
    assert.equal(ref.legacyMaxDifference, 0, 'declined/old-plane helper values remain bit-exact');
    assert(ref.renderMax.baseline > 8, 'unchanged renderer negative control reproduces');
    assert(
      Object.entries(ref.directMax).some(([k, v]) => k.startsWith('baseline') && v > 8),
      'unchanged helper negative control reproduces',
    );
  }
  const fixed = report.rows.find((r) => r.version === 'candidate');
  assert(
    fixed.actualPrograms.some((p) =>
      p.some(
        (s) =>
          (s.match(/if \(seCirclePlaneSafe\(/g) || []).length === 4 &&
          s.includes('reach <= 2.0 * max(abs(dot(u, hx)), abs(dot(u, hy)))'),
      ),
    ),
    'actual executed stroke fragment contains all4fixed sites',
  );
  assert(
    fixed.renders.filter((r) => r.mode === 'morph').length === 3 &&
      fixed.renders.filter((r) => r.mode === 'morph').every((r) => r.usesGpuCurveLerp),
    '3 actual GPU morph cases',
  );
  assert(
    fixed.actualPrograms.some((p) =>
      p.some(
        (s) => s.includes('texelFetch(uA') && s.includes('texelFetch(uB') && s.includes('mix('),
      ),
    ),
    'actual GPU interpolation program executed',
  );
  report.passed = true;
  save();
  console.log(JSON.stringify(report.areaSummary));
  console.log('strokeBigCircleGpuSmoke PASS');
} catch (e) {
  report.error = e.stack;
  save();
  throw e;
} finally {
  cap.clear();
  await stop();
}
