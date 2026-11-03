// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Run the shipped straight-chain shader on the physical GPU, against independent
// polygon clipping. The chain-order closure, a mutation control, must reproduce its failure in this run.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime } from './_gpuThrottle.mjs';
import { randomCrossingChains } from '../probes/lbAccuracy/_chainExact.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shader = readFileSync(path.join(root, 'src/shaders/_boxCov.glsl'), 'utf8'),
  before = readFileSync(path.join(root, 'test/fixtures/lb-chain-before.glsl'), 'utf8');
const cases = randomCrossingChains(80000, 0x2545f491, (p) => p.map(Math.fround));
assert(cases.length > 10000);
assert(cases.filter((c) => c.runs > 1).length > 1000);
let browser;
const stop = async () => {
  if (browser) await browser.close();
};
const cap = capWallTime('kernel GPU', stop, 60000);
try {
  browser = await launchBrowser({
    headless: 'new',
    args:
      process.env.MANTLE_TEST_GL === 'swiftshader'
        ? ['--enable-unsafe-swiftshader', '--no-sandbox']
        : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  await installGpuThrottle(page);
  const got = await page.evaluate(
    async ({ shader, before, points }) => {
      const canvas = document.getElementById('c'),
        width = 128,
        height = Math.ceil(points.length / width);
      canvas.width = width;
      canvas.height = height;
      const gl = canvas.getContext('webgl2', { antialias: false });
      if (!gl) throw Error('WebGL2 unavailable');
      const debug = gl.getExtension('WEBGL_debug_renderer_info'),
        renderer = debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
      if (/swiftshader|llvmpipe|software/i.test(renderer))
        throw Error('Physical GPU required: ' + renderer);
      if (!gl.getExtension('EXT_color_buffer_float')) throw Error('Float readback unavailable');
      const compile = (kind, source) => {
        const s = gl.createShader(kind);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
        return s;
      };
      const vs = compile(
        gl.VERTEX_SHADER,
        '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}',
      );
      const fs = compile(
        gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;precision highp int;uniform sampler2D uPoints;out vec4 outColor;\n' +
          shader +
          '\n' +
          before +
          '\nvoid main(){int i=int(gl_FragCoord.x)+int(gl_FragCoord.y)*128;vec2 p[5];for(int j=0;j<5;j++)p[j]=texelFetch(uPoints,ivec2(j,i),0).xy;outColor=vec4(chainBoxCov(p[0],p[1],p[2],p[3],p[4],2.0),chainBoxCovBefore(p[0],p[1],p[2],p[3],p[4],2.0),0,1);}',
      );
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const texture = (w, h, data) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
        return t;
      };
      const out = texture(width, height, null),
        fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw Error('Float FBO incomplete');
      const data = new Float32Array(5 * height * width * 4);
      for (let i = 0; i < points.length; i++)
        for (let j = 0; j < 5; j++) {
          data[(i * 5 + j) * 4] = points[i][j][0];
          data[(i * 5 + j) * 4 + 1] = points[i][j][1];
        }
      gl.activeTexture(gl.TEXTURE0);
      const input = texture(5, height * width, data);
      gl.uniform1i(gl.getUniformLocation(prog, 'uPoints'), 0);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);
      const start = performance.now();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!(await window.__gpuFence(gl, 15000))) throw Error('GPU fence failed');
      await window.__gpuIdle(performance.now() - start);
      const pixels = new Float32Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
      if (gl.getError() !== gl.NO_ERROR) throw Error('GPU error');
      return {
        renderer,
        values: Array.from(pixels.subarray(0, points.length * 4)),
        duty: window.__gpuDuty(),
      };
    },
    { shader, before, points: cases.map((c) => c.pts) },
  );
  let worst = 0,
    bad = 0,
    oldWorst = 0,
    oldBad = 0;
  for (let i = 0; i < cases.length; i++) {
    const e = Math.abs(got.values[i * 4] - cases[i].want),
      o = Math.abs(got.values[i * 4 + 1] - cases[i].want);
    worst = Math.max(worst, e);
    oldWorst = Math.max(oldWorst, o);
    if (e > 0.05 / 255) bad++;
    if (o > 0.05 / 255) oldBad++;
  }
  assert.equal(bad, 0, 'shipped GPU shader vs independent clipped polygon');
  assert(oldBad > 1000 && oldWorst > 0.9, 'chain-order GPU closure reproduces the failure');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const report = {
    renderer: got.renderer,
    cases: cases.length,
    multiRun: cases.filter((c) => c.runs > 1).length,
    worstByte: worst * 255,
    bad,
    oldWorstByte: oldWorst * 255,
    oldBad,
    shaderHash: hash(shader),
    oldKernelHash: hash(before),
    casesHash: hash(JSON.stringify(cases)),
    duty: got.duty,
  };
  if (process.env.MANTLE_GPU_REPORT_DIR) {
    mkdirSync(process.env.MANTLE_GPU_REPORT_DIR, { recursive: true });
    writeFileSync(
      path.join(process.env.MANTLE_GPU_REPORT_DIR, 'lb-chain-border.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
  console.log('lbChainBorderGpuSmoke PASS ' + JSON.stringify(report));
} finally {
  cap.clear();
  await stop();
}
