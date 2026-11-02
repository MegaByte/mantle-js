// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cacheBlitVertexMapSmoke — the cache blit maps its quad into the canvas-sized texture PER VERTEX.
//
// Every cache, filter and normal-group composite draws cacheBlit over a rect of the
// canvas and reads a canvas-sized texture; mapping the quad's uv into it (uv * uInMap.xy +
// uInMap.zw) in the fragment stage costs a multiply-add per pixel. The map is affine, so
// cacheBlit.vert applies it and the rasterizer interpolates it. uInMap is a uniform of the same
// program, so callers set it as for any uniform. The tint multiply stays: it is the group's opacity.
//
// (1) THE FRAGMENT STAGE, both texts on the CPU in float32 (the _filtperfCases.mjs item below: the whole
//     texture, a group rect at opacity 0.6, an odd rect), the new one fed the mapped uv as the vertex
//     stage produces it: bit-identical.
// (2) THE SHAPE: the shipped fragment declares no uInMap and the shipped vertex stage does (a
//     per-fragment map fails this).
// On the GPU, each text with its own vertex stage: filterPassParityRenderSmoke; and the blit's users
// in the render lane (staticCacheSmoke, filterBakeCacheSmoke, filterCompositeBackdropSmoke,
// groupOverBlitRenderSmoke).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, emulateCase, buildFragEmu, generatedShader } from './_fragEmu.mjs';
import { filtperfCases } from './_filtperfCases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasCxx()) {
  console.log('SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}

for (const c of filtperfCases(['cacheBlitMap'])) {
  let r;
  try {
    r = emulateCase(ROOT, c);
  } catch (e) {
    ok(false, `${c.name}: ${String(e.message).split('\n')[0]}`);
    continue;
  }
  ok(
    r.bits === 0,
    `${c.name}: bit-identical over ${r.n} pixels (${r.bits} float bits differ)` +
      (r.off ? ` -- ${JSON.stringify(r.off)}` : ''),
  );
}
const frag = buildFragEmu(generatedShader(ROOT, 'cacheBlit.frag.glsl'));
const vert = readFileSync(path.join(ROOT, 'src/shaders/generated/cacheBlit.vert.glsl'), 'utf8');
ok(
  !frag.uniforms.includes('uInMap') && /uniform\s+vec4\s+uInMap\s*;/.test(vert),
  `the uv map is the vertex stage's (fragment uniforms: ${frag.uniforms.join(', ')}; vertex declares uInMap: ${/uInMap/.test(vert)})`,
);

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
