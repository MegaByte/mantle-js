// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// execute the shipped angle, disc-sector and winding functions on GPU.
// Right-angle dot products reach -0 even from ordinary positive-zero coordinates.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (n) => readFileSync(path.join(ROOT, 'src/shaders', n), 'utf8');
function fn(src, name) {
  const start = src.indexOf('float ' + name + '(');
  if (start < 0) throw Error('missing shipped function ' + name);
  let i = src.indexOf('{', start),
    depth = 1,
    end = i + 1;
  while (depth && end < src.length) {
    if (src[end] === '{') depth++;
    if (src[end] === '}') depth--;
    end++;
  }
  return src.slice(start, end);
}
const angle = fn(read('_arcMath.glsl'), 'curveAtan2');
if (fn(read('_strokeVertexSetup.glsl'), 'curveAtan2') !== angle)
  throw Error('vertex/fragment axis guards disagree');
const coverage = read('_coverage.glsl');
const functions = angle + '\n' + fn(coverage, 'seSector') + '\n' + fn(coverage, 'gwnChord');
// Helper cases cover both signs of zero, each vertical direction, origin and all quadrants.
const cases = [
  [1, -0],
  [-1, -0],
  [1, 0],
  [-1, 0],
  [0, -0],
  [-0, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, -1e-20],
  [1e-20, 2],
];
const pairs = [
  [-1, 0, 0, -1],
  [-1, 0, 0, 1],
  [0, -1, 1, 0],
  [0, 1, -1, 0],
  [1, 0, 0, 1],
  [1, 1, -1, 1],
];
const rows = cases.map((yx, i) => ({ yx, ab: pairs[i % pairs.length] }));
const N = rows.length;
const fragment = `#version 300 es
precision highp float; precision highp int;
uniform uvec2 uYX[${N}]; uniform vec4 uAB[${N}]; out vec4 o;
const float TWO_PI=6.283185307179586, GWN_TAU=6.283185307179586;
${functions}
void main(){int i=int(gl_FragCoord.x);vec2 yx=vec2(uintBitsToFloat(uYX[i].x),uintBitsToFloat(uYX[i].y));vec4 ab=uAB[i];
o=vec4(curveAtan2(yx.x,yx.y),seSector(ab.xy,ab.zw,1.0),gwnChord(vec2(0.0),ab.xy,ab.zw),atan(yx.x,yx.y));}`;
const html = `<canvas id=c width=${N} height=1></canvas><script>
const gl=document.getElementById('c').getContext('webgl2',{antialias:false});
if(!gl || !gl.getExtension('EXT_color_buffer_float'))throw Error('float render target unavailable');
const mk=(t,s)=>{const q=gl.createShader(t);gl.shaderSource(q,s);gl.compileShader(q);if(!gl.getShaderParameter(q,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(q));return q;};
const pr=gl.createProgram();gl.attachShader(pr,mk(gl.VERTEX_SHADER,${JSON.stringify('#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}'.replaceAll('\\n', '\n'))}));
gl.attachShader(pr,mk(gl.FRAGMENT_SHADER,${JSON.stringify(fragment)}));gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(pr));
const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA32F,${N},1);
const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('incomplete float framebuffer');
gl.useProgram(pr);gl.bindVertexArray(gl.createVertexArray());gl.viewport(0,0,${N},1);
// Transmit exact IEEE bits, rather than relying on JS/GL serialization of -0.
const yx=new Float32Array(${JSON.stringify(rows.flatMap((r) => r.yx).map((v) => (Object.is(v, -0) ? 'NEG_ZERO' : v)))}.map(v=>v==='NEG_ZERO'?-0:v));
gl.uniform2uiv(gl.getUniformLocation(pr,'uYX'),new Uint32Array(yx.buffer));
gl.uniform4fv(gl.getUniformLocation(pr,'uAB'),new Float32Array(${JSON.stringify(rows.flatMap((r) => r.ab))}));
gl.drawArrays(gl.TRIANGLES,0,3);const px=new Float32Array(${N * 4});gl.readPixels(0,0,${N},1,gl.RGBA,gl.FLOAT,px);
const d=gl.getExtension('WEBGL_debug_renderer_info');window.out={values:Array.from(px),error:gl.getError(),backend:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
</script>`;
const srv = http.createServer((q, r) => {
  r.setHeader('Content-Type', 'text/html');
  r.end(html);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--no-sandbox', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-angle=metal', '--use-gl=angle'],
});
let out;
try {
  const page = await br.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForFunction(() => window.out, { polling: 100, timeout: 30000 });
  out = await page.evaluate(() => window.out);
} finally {
  await br.close();
  srv.close();
}
let failures = 0,
  rawWrong = 0;
const check = (c, m) => {
  if (!c) {
    failures++;
    console.error('FAIL ' + m);
  }
};
rows.forEach((r, i) => {
  const [y, x] = r.yx,
    [ax, ay, bx, by] = r.ab,
    cross = ax * by - ay * bx,
    dot = ax * bx + ay * by;
  const expected = x === 0 ? (y === 0 ? 0 : (Math.sign(y) * Math.PI) / 2) : Math.atan2(y, x);
  const geometric = Math.atan2(cross, dot);
  const wants = [expected, geometric / 2, geometric / (2 * Math.PI)];
  wants.forEach((v, k) =>
    check(
      Number.isFinite(out.values[4 * i + k]) && Math.abs(out.values[4 * i + k] - v) < 2e-4,
      `case ${i} channel ${k}: ${out.values[4 * i + k]} vs ${v}`,
    ),
  );
  if (Math.abs(out.values[4 * i + 3] - expected) > 0.01) rawWrong++;
});
check(out.error === 0, 'GL error ' + out.error);
console.log(JSON.stringify({ backend: out.backend, cases: N, rawAtanWrong: rawWrong, failures }));
if (failures) process.exit(1);
console.log(
  'curveAngleSignedZeroGpuSmoke PASS: shipped angle, disc-sector and winding functions retain signed quarter turns',
);
