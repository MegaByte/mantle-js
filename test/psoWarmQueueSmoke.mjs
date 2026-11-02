// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
const solid = '<path d="M10 10 L50 10 L50 50 L10 50 Z" fill="#f00"/>';
const stroke = '<path d="M10 10 L50 10 L50 50" fill="none" stroke="#0a0" stroke-width="3"/>';
const sections = await importSvg(svg(solid), { preserveViewport: true });
const strokeSections = await importSvg(svg(stroke), { preserveViewport: true });
for (const draws of [true, false]) {
  const F = createFakeGl({ width: 64, height: 64 });
  // aacPoints:false -- a 40 px solid at 64 px takes the vertex-stage point route, whose warm links the point program
  // and leaves the fill variant unmarked; this test is about the fill variants' duplicate stop, so it draws them as cover quads.
  const R = createRenderer(F.gl, taggedShaderSources(), {
    psoWarmIdle: () => true,
    precompileFillsBudgetMs: 100000,
    aacPoints: false,
  });
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  R.setViewport(64, 64);
  // Creation prewarm drains newest first: a unique older stroke follows nine duplicate fills.
  createBundle(F.gl, strokeSections);
  for (let i = 0; i < 9; i++) createBundle(F.gl, sections);
  F.setFrame('first');
  const first = R.precompileFills({ draw: draws });
  F.setFrame('second');
  const second = R.precompileFills({ draw: draws });
  F.setFrame('third');
  const third = R.precompileFills({ draw: draws });
  console.log({
    draws,
    first,
    second,
    third,
    secondDraws: F.log.filter((e) => e.frame === 'second' && e.op === 'draw').length,
  });
  assert.equal(
    first,
    9,
    'one new variant followed by eight duplicate variants stops the first call',
  );
  assert.equal(second, 1, 'the later unique pipeline survives the duplicate stop');
  assert.equal(third, 0, 'the consumed queue empties');
  if (draws)
    assert(
      F.log.some((e) => e.frame === 'second' && e.op === 'draw'),
      'second call really draws the unique pipeline',
    );
  else assert(!F.log.some((e) => e.op === 'draw'), 'draw:false remains free of warm draws');
  R.dispose();
}
{
  const F = createFakeGl({ width: 64, height: 64 });
  const R = createRenderer(F.gl, taggedShaderSources(), {
    psoWarmIdle: () => true,
    precompileFillsBudgetMs: 0,
  });
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  R.setViewport(64, 64);
  createBundle(F.gl, sections);
  F.setFrame('budget');
  assert.equal(R.precompileFills(), 0);
  assert(
    !F.log.some((e) => e.frame === 'budget' && e.op === 'draw'),
    'zero budget issues no pipeline warm',
  );
  F.setFrame('idle');
  for (let i = 0; i < 4; i++) {
    R.beginFrame([0, 0, 0, 0]);
    R.endFrame();
  }
  assert(
    F.log.some((e) => e.frame === 'idle' && e.op === 'draw' && e.sc?.join() === '0,0,1,1'),
    'the budget-limited pipeline survives for an idle warm',
  );
  R.dispose();
}
{
  const F = createFakeGl({ width: 0, height: 0 });
  const R = createRenderer(F.gl, taggedShaderSources(), { precompileFillsBudgetMs: 100000 });
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  R.setViewport(null);
  createBundle(F.gl, sections);
  assert.equal(R.precompileFills(), 0, 'an unsized canvas defers its pipeline warm');
  R.setViewport(64, 64);
  F.setFrame('sized');
  assert.equal(R.precompileFills(), 1, 'sizing the canvas preserves the deferred entry');
  assert(
    F.log.some((e) => e.frame === 'sized' && e.op === 'draw'),
    'the deferred pipeline actually draws',
  );
  R.dispose();
}
// Disposed backlog entries do not consume the duplicate-work limit.
for (const draws of [true, false]) {
  const F = createFakeGl({ width: 64, height: 64 });
  const R = createRenderer(F.gl, taggedShaderSources(), {
    psoWarmIdle: () => true,
    precompileFillsBudgetMs: 100000,
    aacPoints: false,
  });
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  R.setViewport(64, 64);
  const expired = Array.from({ length: 64 }, () => createBundle(F.gl, sections));
  assert.equal(R.precompileFills({ draw: false }), 9);
  for (const b of expired) b.dispose();
  const live = createBundle(F.gl, strokeSections);
  F.setFrame('after-disposal');
  assert.equal(
    R.precompileFills({ draw: draws }),
    1,
    'disposed entries cannot hide the later live pipeline',
  );
  assert.equal(R.precompileFills({ draw: draws }), 0, 'the disposed backlog is consumed');
  assert.equal(
    F.log.some((e) => e.frame === 'after-disposal' && e.op === 'draw'),
    draws,
  );
  live.dispose();
  R.dispose();
}
// Pending known targets retain their queue position without blocking ready work.
{
  const F = createFakeGl({ width: 512, height: 512 });
  const KHR = { COMPLETION_STATUS_KHR: 0x91b1 };
  const source = new WeakMap(),
    attached = new WeakMap();
  let program = null,
    hold = true,
    observing = false,
    forcedLinks = 0,
    plainDraws = 0,
    filterDraws = 0;
  const plain = (p) =>
    (attached.get(p) || []).some((s) => (source.get(s) || '').includes('#define MANTLE_NO_FILTER'));
  const gl = new Proxy(F.gl, {
    get(t, k) {
      if (k === 'getExtension')
        return (n) => (n === 'KHR_parallel_shader_compile' ? KHR : t.getExtension(n));
      if (k === 'shaderSource')
        return (s, text) => {
          source.set(s, text);
          return t.shaderSource(s, text);
        };
      if (k === 'attachShader')
        return (p, s) => {
          if (!attached.has(p)) attached.set(p, []);
          attached.get(p).push(s);
          return t.attachShader(p, s);
        };
      if (k === 'useProgram')
        return (p) => {
          program = p;
          return t.useProgram(p);
        };
      if (k === 'getProgramParameter')
        return (p, e) => {
          if (e === KHR.COMPLETION_STATUS_KHR) return !hold || plain(p);
          if (
            observing &&
            hold &&
            !plain(p) &&
            e === t.LINK_STATUS &&
            new Error().stack.includes('_promote')
          )
            forcedLinks++;
          return t.getProgramParameter(p, e);
        };
      if (k === 'drawArrays')
        return (...a) => {
          if (observing) {
            if (plain(program)) plainDraws++;
            else filterDraws++;
          }
          return t.drawArrays(...a);
        };
      return t[k];
    },
  });
  const R = createRenderer(gl, taggedShaderSources(), {
    variantFirst: false,
    aacPoints: false,
    psoWarmIdle: () => true,
  });
  R.setViewport(512, 512);
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const filtered = await importSvg(
    svg(
      '<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs><path d="M10 10H50V50H10Z" filter="url(#f)" fill="#00f"/>',
    ),
  );
  const live = createBundle(gl, sections);
  const blocked = Array.from({ length: 12 }, () => createBundle(gl, filtered));
  const tick = () => {
    R.beginFrame([0, 0, 0, 0]);
    R.endFrame();
  };
  observing = true;
  for (let i = 0; i < 30; i++) tick();
  assert.equal(forcedLinks, 0, 'automatic warming never force-links an unfinished known target');
  assert(plainDraws > 0, 'a ready pipeline behind held targets receives a warm draw');
  assert.equal(filterDraws, 0, 'unfinished targets are not credited by drawing another program');
  for (const b of blocked.slice(0, 6)) b.dispose();
  hold = false;
  for (let i = 0; i < 30; i++) tick();
  assert(filterDraws > 0, 'released surviving targets remain queued and receive warm draws');
  blocked.slice(6).forEach((b) => b.dispose());
  live.dispose();
  R.precompileFills();
  const before = plainDraws + filterDraws;
  for (let i = 0; i < 4; i++) tick();
  assert.equal(
    plainDraws + filterDraws,
    before,
    'disposed and completed targets leave no warm backlog',
  );
  R.dispose();
}

console.log('psoWarmQueueSmoke PASS');
