// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchPinDeclineRecordSmoke -- a pinned CPatch that did not draw says why. Before its build lands a draw takes the cover kernel and records `pending`; a row an override takes off its
// patches records `unsupported`; a draw CPatch served records neither. The first bundle of a process reaches the unified draw before its build, and must record too.
// CPU, driver-model stand-in.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg, createOverrideTable } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SRC =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="a" d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/><path id="c" d="M20 20 C 70 10 90 40 80 80 L 20 70 Z" fill="#a03"/></svg>';

async function run(override) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), { asyncShaderCompile: true });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(256, 256);
  R.setFillEngine({ route: 'cpatch' });
  const b = createBundle(W.gl, await importSvg(SRC));
  const o = {};
  if (override) {
    o.overrides = createOverrideTable(W.gl, b);
    o.overrides.set('a', override);
  }
  const f = () => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, o);
    R.endFrame();
  };
  f();
  const first = {
    d: { ...R.debugStats.engines.draws },
    n: { ...(R.debugStats.engines.declines.cpatch || {}) },
  };
  const ready = await R.awaitEngine(b, 'cpatch', 20000);
  for (let i = 0; i < 8; i++) {
    f();
    await new Promise((r) => setTimeout(r, 4));
  }
  const after = {
    d: { ...R.debugStats.engines.draws },
    n: { ...(R.debugStats.engines.declines.cpatch || {}) },
  };
  R.dispose();
  return { first, ready, after };
}
for (const label of ['the first bundle of the process', 'a later bundle']) {
  const r = await run(null);
  ok(
    r.first.d.slug > 0 && r.first.n.pending === r.first.d.slug,
    `${label}, before the build lands: every cover draw records pending (${r.first.d.slug} drawn, ${r.first.n.pending} pending)`,
  );
  ok(
    r.ready &&
      r.after.d.cpatch > 0 &&
      r.after.d.slug === r.first.d.slug &&
      !r.after.n.unsupported &&
      r.after.n.pending === r.first.n.pending,
    `${label}, built: CPatch draws and nothing more is recorded (${JSON.stringify(r.after)})`,
  );
}
{
  const r = await run({ localPosition: [5, 5] });
  ok(
    r.ready && r.after.n.unsupported > 0,
    `a row an override moves off its patches, built: records unsupported (${JSON.stringify(r.after.n)})`,
  );
}
if (fail) {
  console.error(`\nCPATCH-PIN-DECLINE-RECORD FAIL (${fail})`);
  process.exit(1);
}
console.log('\nCPATCH-PIN-DECLINE-RECORD PASS');
