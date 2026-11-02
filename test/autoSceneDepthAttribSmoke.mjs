// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// autoSceneDepthAttribSmoke — createMantleScene must ask for the buffers the renderer uses.
//
// `chooseBackend` / `createMantleScene` is the convenience entry point ("no bundler, no
// shaders, just give me a scene"), so its default `getContext('webgl2', …)` attributes are the
// ones most consumers of that path actually get. `depth: false, stencil: true` would be exactly
// backwards:
//
//   * the fill pass enables DEPTH_TEST with LEQUAL and WRITES depth; `_renderCanvasInner`
//     clears depth per bundle so a later bundle does not depth-test against an earlier one;
//     the unified draw CLAIMS depth so one shape cannot paint a pixel twice where two of its
//     own pieces meet; and the opaque prepass is depth-only. Every offscreen target the
//     renderer builds for itself attaches DEPTH24_STENCIL8 for this reason. With `depth: false`
//     the DEFAULT framebuffer has none: the test always passes, the writes go nowhere, and the
//     depth claim silently does nothing — a translucent self-overlapping shape composites
//     twice, with no error anywhere.
//
//   * nothing in src/ ever tests the stencil buffer — zero `stencilFunc`, zero `stencilOp` —
//     so asking for one allocates a buffer no fragment reads.
//
// Driven from Node with a stub canvas that records the attribute object. No GL needed: the
// question is what Mantle ASKS FOR, which is a property of the call.
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const { chooseBackend } = await import('../src/fallback/autoScene.js');

/// A canvas that answers getContext with a marker and keeps what it was asked for.
function stubCanvas() {
  const c = {
    asked: null,
    getContext: (kind, attrs) => {
      c.asked = { kind, attrs };
      return { CONTEXT: 1 };
    },
  };
  return c;
}

console.log('\n  default context attributes:');
{
  const c = stubCanvas();
  const r = chooseBackend(c, {});
  ok(r.backend === 'webgl', 'a canvas that yields a context selects the WebGL backend');
  const a = c.asked && c.asked.attrs;
  ok(!!a, 'getContext was called with an attribute object');
  ok(c.asked.kind === 'webgl2', 'and it asked for webgl2');
  ok(
    a.depth === true,
    `depth is requested (${a && a.depth}) — the fill pass depth-tests and writes`,
  );
  ok(
    a.stencil === false,
    `stencil is NOT requested (${a && a.stencil}) — nothing ever stencil-tests`,
  );
  ok(a.antialias === false, 'antialias stays off (coverage is analytic)');
  ok(a.premultipliedAlpha === true, 'premultipliedAlpha stays on');
}

console.log('\n  an explicit override still wins:');
{
  const c = stubCanvas();
  const mine = { depth: false, stencil: false, alpha: true };
  chooseBackend(c, { glAttribs: mine });
  ok(c.asked.attrs === mine, 'opts.glAttribs is passed through unchanged');
}

console.log('\n  and the renderer really does depend on depth:');
{
  // Read the source rather than asserting from memory: if the fill pass ever stops enabling
  // DEPTH_TEST, the attribute above stops being required and this smoke should be the thing
  // that says so.
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const path = await import('path');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fillPass = readFileSync(path.join(ROOT, 'src/renderer/fillPass.js'), 'utf8');
  const renderer = readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8');
  ok(/glEnable\(gl\.DEPTH_TEST\)/.test(fillPass), 'the fill pass enables DEPTH_TEST');
  ok(/glDepthMask\(!R\._opaquePrepassActive\)/.test(fillPass), '...and writes depth');
  ok(
    /gl\.clear\(gl\.STENCIL_BUFFER_BIT \| gl\.DEPTH_BUFFER_BIT\)/.test(renderer),
    'and every drawBundle clears depth, which needs a depth buffer to clear',
  );
  ok(!/\.stencilFunc\s*\(/.test(fillPass + renderer), 'neither file ever calls stencilFunc');
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
