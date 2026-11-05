// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rememberFailedWebglSmoke — a WebGL start that failed is not tried again on that GPU and browser.
//
// A driver that cannot build Mantle's large programs (a Galaxy Tab A's Mali-T830 in Chrome 101: maskBake 11 s, splitStroke 19 s, each then
// failing) holds the browser's GPU process while it tries, so no frame draws, native SVG included, and no timeout can cut it short. Only not
// starting is fast, so createMantleScene remembers the failure in localStorage and the next load starts native at once.
//
// Driven from Node with a stub canvas and stub storage: the question is what Mantle chooses, not what it draws.
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
};
const browser = (userAgent) => Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });

const { chooseBackend, createMantleScene } = await import('../src/fallback/autoScene.js');

const UNMASKED_RENDERER_WEBGL = 0x9246;
/// A canvas whose context names its GPU and records whether it was lost. `answers` limits how many times it names it: a context
/// whose start failed answers no more, as on the Tab A.
function stubCanvas(gpu, answers = Infinity) {
  const gl = {
    lost: false,
    getParameter: (p) => (p === UNMASKED_RENDERER_WEBGL && answers-- > 0 ? gpu : null),
    getExtension: (name) =>
      name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_RENDERER_WEBGL }
        : name === 'WEBGL_lose_context'
          ? { loseContext: () => (gl.lost = true) }
          : null,
  };
  return { gl, getContext: () => gl };
}

browser('Chrome/101');

console.log('\n  before any failure:');
{
  const r = chooseBackend(stubCanvas('Mali-T830'), {});
  ok(r.backend === 'webgl', 'a GPU with no failure tries WebGL');
  ok(r.webglFailed === null, 'and reports no failure');
}

console.log('\n  a WebGL start that fails is remembered:');
{
  const c = stubCanvas('Mali-T830', 1);
  const quiet = console.warn;
  console.warn = () => {};
  await createMantleScene(c, { shaders: {} }).catch(() => {});
  console.warn = quiet;
  ok(stored.size === 1, 'the failure is stored');
}

console.log('\n  the next load on that GPU and browser starts native:');
{
  const c = stubCanvas('Mali-T830');
  const r = chooseBackend(c, {});
  ok(r.backend === 'native', 'it chooses native without trying WebGL');
  ok(r.gl === null, 'with no context');
  ok(c.gl.lost === true, 'and releases the context it asked for');
  ok(JSON.stringify(r.webglFailed) === JSON.stringify(['Mali-T830', 0]), `and reports the GPU with 0 ms spent (${JSON.stringify(r.webglFailed)})`);
}

console.log('\n  what still tries WebGL:');
{
  ok(chooseBackend(stubCanvas('Mali-G72'), {}).backend === 'webgl', 'another GPU');
  browser('Chrome/120');
  ok(chooseBackend(stubCanvas('Mali-T830'), {}).backend === 'webgl', 'the same GPU in an updated browser');
  browser('Chrome/101');
  ok(chooseBackend(stubCanvas('Mali-T830'), { backend: 'webgl' }).backend === 'webgl', "backend:'webgl', which forces it");
  ok(chooseBackend(stubCanvas('Mali-T830'), { rememberFailedWebgl: false }).backend === 'webgl', 'rememberFailedWebgl: false');
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
