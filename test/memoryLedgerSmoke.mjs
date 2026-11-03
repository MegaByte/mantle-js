// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// memoryLedgerSmoke -- renderer.getMemoryStats() is byte-accurate against an independent spy on texImage2D / texImage3D / texStorage /
// bufferData / renderbufferStorage, per category and per bundle, and returns to zero when the bundles and the renderer are disposed.
//
// The ORACLE is a spy installed on the context BEFORE the renderer exists. It tracks the bindings itself (activeTexture, bindTexture,
// bindBuffer, bindRenderbuffer) and the size each allocating call asked for, and drops an object at its delete call; it knows nothing of the
// memory ledger. The scenes cover a plain fill, gradient + stroke, a blurred shape (pool, shape and ping targets, filter cache), a faded group
// (frame targets / atlas), a mask, an image and two bundles, drawn headless on test/_fakeGl.mjs. Unit cases then pin each allocating call's
// size rule (mip chain, texStorage levels, the bufferData srcOffset / length overload, multisample renderbuffers) and that a resource the
// library did not create is never counted.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const { ledgerFor } = await import('../src/renderer/memoryLedger.js');
const { trackGlResource } = await import('../src/renderer/contextResources.js');

const FMT = (gl) => ({
  [gl.RGBA8]: 4,
  [gl.R8]: 1,
  [gl.RGBA32F]: 16,
  [gl.R32I]: 4,
  [gl.RGBA16F]: 8,
  [gl.DEPTH24_STENCIL8]: 4,
  [gl.R32F]: 4,
  [gl.RGBA32UI]: 16,
});
const UNSIZED = (gl) => ({ [gl.RGBA]: 4, [gl.RED]: 1, [gl.RED_INTEGER]: 1 });
const TYPE = (gl) => ({ [gl.UNSIGNED_BYTE]: 1, [gl.FLOAT]: 4, [gl.INT]: 4 });

/** An independent oracle: the live bytes of every object, from the allocating calls alone. */
function installSpy(gl) {
  const fmt = FMT(gl),
    uns = UNSIZED(gl),
    typ = TYPE(gl);
  const unit = { v: 0 };
  const texBound = new Map(),
    bufBound = new Map();
  let rbBound = null;
  const bytes = new Map(); // object -> { bytes, kind, levels }
  const calls = { texImage2D: 0, bufferData: 0, renderbufferStorage: 0 };
  const orig = {};
  const wrap = (name, fn) => {
    orig[name] = gl[name];
    gl[name] = function (...a) {
      const r = orig[name].apply(gl, a);
      fn(...a);
      return r;
    };
  };
  wrap('activeTexture', (u) => {
    unit.v = u;
  });
  wrap('bindTexture', (t, o) => {
    texBound.set(t + ':' + unit.v, o);
  });
  wrap('bindBuffer', (t, o) => {
    bufBound.set(t, o);
  });
  wrap('bindRenderbuffer', (t, o) => {
    rbBound = o;
  });
  const rec = (o, kind) => {
    let r = bytes.get(o);
    if (!r) {
      r = { bytes: 0, kind, levels: new Map() };
      bytes.set(o, r);
    }
    return r;
  };
  const sum = (r) => {
    let s = 0;
    for (const v of r.levels.values()) s += v;
    r.bytes = s;
  };
  const per = (internal, format, type) => {
    if (fmt[internal]) return fmt[internal];
    if (uns[format] && typ[type]) return uns[format] * typ[type];
    throw new Error('oracle: unknown format ' + internal + '/' + format + '/' + type);
  };
  wrap('texImage2D', (t, level, internal, w, h, _b, format, type) => {
    calls.texImage2D++;
    const o = texBound.get(t + ':' + unit.v);
    const r = rec(o, 'texture');
    r.levels.set(level, w * h * per(internal, format, type));
    sum(r);
  });
  wrap('texImage3D', (t, level, internal, w, h, d, _b, format, type) => {
    const o = texBound.get(t + ':' + unit.v);
    const r = rec(o, 'texture');
    r.levels.set(level, w * h * d * per(internal, format, type));
    sum(r);
  });
  wrap('bufferData', (t, d) => {
    calls.bufferData++;
    const o = bufBound.get(t);
    const r = rec(o, 'buffer');
    r.levels.set(0, typeof d === 'number' ? d : d.byteLength);
    sum(r);
  });
  wrap('renderbufferStorage', (_t, internal, w, h) => {
    calls.renderbufferStorage++;
    const r = rec(rbBound, 'renderbuffer');
    r.levels.set(0, w * h * fmt[internal]);
    sum(r);
  });
  for (const n of ['deleteTexture', 'deleteBuffer', 'deleteRenderbuffer'])
    wrap(n, (o) => {
      bytes.delete(o);
    });
  return {
    calls,
    total: () => {
      let s = 0;
      for (const r of bytes.values()) s += r.bytes;
      return s;
    },
    ofKind: (k) => {
      let s = 0;
      for (const r of bytes.values()) if (r.kind === k) s += r.bytes;
      return s;
    },
    bytesOf: (o) => (bytes.get(o) ? bytes.get(o).bytes : 0),
  };
}

const N = 96;
const REGION = 'x="-50%" y="-50%" width="200%" height="200%"';
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs><filter id="b" ${REGION}><feGaussianBlur stdDeviation="2"/></filter>` +
  '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>' +
  `<mask id="m"><circle cx="48" cy="48" r="30" fill="#fff"/></mask></defs>${body}</svg>`;
const SCENES = {
  plain: '<rect x="8" y="8" width="60" height="60" fill="#f00"/>',
  gradStroke:
    '<path d="M10 80 C 30 10 60 10 80 80Z" fill="url(#g)" stroke="#000" stroke-width="3"/>',
  blurred:
    '<rect x="10" y="10" width="40" height="40" fill="#0a0"/><circle cx="60" cy="50" r="18" fill="#00f" filter="url(#b)"/>',
  group:
    '<g opacity="0.5"><rect x="10" y="10" width="50" height="50" fill="#f00"/><circle cx="60" cy="60" r="20" fill="#00f"/></g>',
  masked: '<rect x="0" y="0" width="96" height="96" fill="#f80" mask="url(#m)"/>',
};

async function scene(F, R, name) {
  const b = createBundle(F.gl, await importSvg(svg(SCENES[name]), { preserveViewport: true }));
  return b;
}

{
  console.log('\n  scenes against the independent spy:');
  const F = createFakeGl({ width: N, height: N });
  const spy = installSpy(F.gl);
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setViewport(N, N);
  const stat = () => R.getMemoryStats();
  let s = stat();
  ok(
    s.gpu.totalBytes === spy.total(),
    `renderer alone: memory ledger ${s.gpu.totalBytes} == spy ${spy.total()}`,
  );
  ok(s.gpu.totalBytes > 0, 'the renderer holds its dummy textures and buffers (nonzero)');
  const bundles = {};
  for (const name of Object.keys(SCENES)) {
    bundles[name] = await scene(F, R, name);
    s = stat();
    ok(
      s.gpu.totalBytes === spy.total(),
      `after createBundle(${name}): memory ledger ${s.gpu.totalBytes} == spy ${spy.total()}`,
    );
    ok(
      s.gpu.textureBytes === spy.ofKind('texture') &&
        s.gpu.bufferBytes === spy.ofKind('buffer') &&
        s.gpu.renderbufferBytes === spy.ofKind('renderbuffer'),
      `  by kind: tex ${s.gpu.textureBytes}/${spy.ofKind('texture')} buf ${s.gpu.bufferBytes}/${spy.ofKind('buffer')} rb ${s.gpu.renderbufferBytes}/${spy.ofKind('renderbuffer')}`,
    );
  }
  // Draw every scene for a few frames: pools, shape targets, atlas, filter cache, vertex streams all allocate.
  for (let i = 0; i < 3; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    for (const b of Object.values(bundles)) R.drawBundle(b);
    R.endFrame();
  }
  s = stat();
  ok(
    s.gpu.totalBytes === spy.total(),
    `after drawing all scenes: memory ledger ${s.gpu.totalBytes} == spy ${spy.total()}`,
  );
  ok(
    spy.calls.texImage2D > 10 && spy.calls.bufferData > 3,
    `the spy saw ${spy.calls.texImage2D} texImage2D and ${spy.calls.bufferData} bufferData calls`,
  );
  const cats = Object.values(s.gpu.byCategory).reduce((n, c) => n + c.bytes, 0);
  ok(cats === s.gpu.totalBytes, `the categories sum to the total (${cats})`);
  ok(
    ['bundle', 'core'].every((c) => s.gpu.byCategory[c] && s.gpu.byCategory[c].bytes > 0),
    `bundle and core categories are populated (${Object.keys(s.gpu.byCategory).join(', ')})`,
  );
  ok(s.gpu.peakBytes >= s.gpu.totalBytes, `peak ${s.gpu.peakBytes} >= total ${s.gpu.totalBytes}`);

  // Per bundle: every row's bytes are exactly its resources' bytes, and the rows are the bundles.
  const rows = s.bundles;
  ok(rows.length >= Object.keys(bundles).length, `one row per bundle (${rows.length})`);
  let rowSum = 0;
  for (const [name, b] of Object.entries(bundles)) {
    const tex = [
      b.curveTex,
      b.bandTex,
      b.metaTex,
      b.gradientTex,
      b.gradientStopsTex,
      b.dashTex,
      b.filterTex,
    ].filter(Boolean);
    const want = tex.reduce((n, t) => n + spy.bytesOf(t), 0);
    const row = rows.find(
      (r) =>
        r.gpuBytes >= want && r.textureBytes >= want && r.shapes === b.numShapes && r.cpuBytes > 0,
    );
    ok(
      !!row && want > 0,
      `bundle ${name}: textures ${want} bytes are inside its row (${row ? row.gpuBytes : 'none'}), CPU ${row ? row.cpuBytes : 0}`,
    );
  }
  for (const r of rows) rowSum += r.gpuBytes;
  ok(rowSum <= s.gpu.totalBytes, `bundle rows (${rowSum}) never exceed the total`);

  // Dispose one bundle: its bytes leave the memory ledger, exactly as the spy sees.
  const before = stat().gpu.totalBytes;
  const bBytes = ['curveTex', 'bandTex', 'metaTex'].reduce(
    (n, k) => n + spy.bytesOf(bundles.plain[k]),
    0,
  );
  bundles.plain.dispose();
  s = stat();
  ok(
    s.gpu.totalBytes === spy.total() && s.gpu.totalBytes <= before - bBytes,
    `dispose(plain): memory ledger ${s.gpu.totalBytes} == spy ${spy.total()} and fell by at least ${bBytes}`,
  );
  for (const [name, b] of Object.entries(bundles)) if (name !== 'plain') b.dispose();
  R.dispose();
  s = R.getMemoryStats();
  ok(
    spy.total() === 0,
    `spy: nothing live after every bundle and the renderer are disposed (${spy.total()})`,
  );
  ok(
    s.gpu.totalBytes === 0,
    `memory ledger: total returns to zero (${s.gpu.totalBytes}); by category ${JSON.stringify(s.gpu.byCategory)}`,
  );
  ok(s.gpu.resources === 0, `memory ledger: no live resources (${s.gpu.resources})`);
}

{
  console.log("\n  each allocating call's size rule:");
  const F = createFakeGl({ width: 8, height: 8 });
  const gl = F.gl;
  const L = ledgerFor(gl);
  const tex = trackGlResource(gl, gl.createTexture(), 'bundle');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 64, 32, 0, gl.RGBA, gl.FLOAT, null);
  ok(L.bytesOf(tex) === 64 * 32 * 16, `texImage2D RGBA32F 64x32 = ${L.bytesOf(tex)}`);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 10, 10, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  ok(L.bytesOf(tex) === 400, `re-specifying level 0 replaces it (${L.bytesOf(tex)})`);
  gl.generateMipmap(gl.TEXTURE_2D);
  let want = 0;
  for (let w = 10, h = 10; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    want += w * h * 4;
    if (w === 1 && h === 1) break;
  }
  ok(L.bytesOf(tex) === want, `generateMipmap adds the chain: ${L.bytesOf(tex)} == ${want}`);
  gl.deleteTexture(tex);
  ok(L.bytesOf(tex) === 0, 'deleteTexture returns the texture to zero');

  const t2 = trackGlResource(gl, gl.createTexture(), 'bundle');
  gl.bindTexture(gl.TEXTURE_2D, t2);
  gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA8, 16, 8);
  ok(L.bytesOf(t2) === (16 * 8 + 8 * 4 + 4 * 2) * 4, `texStorage2D levels 3: ${L.bytesOf(t2)}`);
  const t3 = trackGlResource(gl, gl.createTexture(), 'mask');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t3);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, 20, 10, 4, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  ok(L.bytesOf(t3) === 20 * 10 * 4, `texImage3D R8 20x10x4 = ${L.bytesOf(t3)}`);

  const buf = trackGlResource(gl, gl.createBuffer(), 'points');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, 1000, gl.DYNAMIC_DRAW);
  ok(L.bytesOf(buf) === 1000, `bufferData(size) = ${L.bytesOf(buf)}`);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(25), gl.STATIC_DRAW);
  ok(L.bytesOf(buf) === 100, `bufferData(Float32Array(25)) = ${L.bytesOf(buf)}`);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(25), gl.STATIC_DRAW, 5, 10);
  ok(L.bytesOf(buf) === 40, `bufferData(data, usage, srcOffset 5, length 10) = ${L.bytesOf(buf)}`);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(30), gl.STATIC_DRAW, 10, 0);
  ok(
    L.bytesOf(buf) === 20,
    `bufferData(data, usage, srcOffset 10, length 0 = to the end) = ${L.bytesOf(buf)}`,
  );

  const rb = trackGlResource(gl, gl.createRenderbuffer(), 'frameTargets');
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, 100, 50);
  ok(L.bytesOf(rb) === 100 * 50 * 4, `renderbufferStorage D24S8 100x50 = ${L.bytesOf(rb)}`);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.DEPTH24_STENCIL8, 100, 50);
  ok(L.bytesOf(rb) === 100 * 50 * 4 * 4, `renderbufferStorageMultisample x4 = ${L.bytesOf(rb)}`);

  const total = L.snapshot().totalBytes;
  const host = gl.createTexture(); // the host's own texture on the same context
  gl.bindTexture(gl.TEXTURE_2D, host);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  ok(
    L.snapshot().totalBytes === total,
    `a texture the library did not create is never counted (${L.snapshot().totalBytes} == ${total})`,
  );

  gl.deleteBuffer(buf);
  gl.deleteRenderbuffer(rb);
  gl.deleteTexture(t2);
  gl.deleteTexture(t3);
  ok(L.snapshot().totalBytes === 0, `everything deleted: ${L.snapshot().totalBytes}`);
  ok(L.snapshot().peakBytes > 0, `peak survives deletion (${L.snapshot().peakBytes})`);
}

{
  console.log('\n  a context behind a forwarding Proxy is left alone, not looped:');
  const { deleteGlResource } = await import('../src/renderer/contextResources.js');
  const base = createFakeGl({ width: 8, height: 8 }).gl;
  const gl = new Proxy(base, {
    get(t, k) {
      const v = t[k];
      return typeof k === 'string' && /^(deleteTexture|texImage2D)$/.test(k)
        ? (...a) => v.apply(t, a)
        : v;
    },
  });
  const L = ledgerFor(gl);
  ok(
    L.snapshot().unpatched.includes('deleteTexture') &&
      L.snapshot().unpatched.includes('texImage2D'),
    `the forwarded methods are listed as unpatched (${L.snapshot().unpatched.join(', ')})`,
  );
  const t = trackGlResource(gl, gl.createTexture(), 'bundle');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); // no recursion, no count
  ok(
    L.bytesOf(t) === 0,
    'an allocation through the forwarding layer is not counted (and does not loop)',
  );
  gl.bufferData(gl.ARRAY_BUFFER, 64, gl.STATIC_DRAW);
  deleteGlResource(gl, 'Texture', t);
  ok(true, 'deleteGlResource through it does not loop');
}

// Shared morph helpers are bounded by context generation and live renderer/morph owners.
{
  const { retainMorphLerpOwner, getLerpPass, releaseLerpPass } =
    await import('../src/renderer/morphLerpPass.js');
  const gl = createFakeGl().gl,
    listeners = [];
  gl.canvas = {
    addEventListener(type, fn) {
      if (type === 'webglcontextlost') listeners.push(fn);
    },
  };
  let created = 0,
    deleted = 0;
  const create = gl.createProgram.bind(gl),
    del = gl.deleteProgram.bind(gl);
  gl.createProgram = () => {
    created++;
    return create();
  };
  gl.deleteProgram = (p) => {
    deleted++;
    del(p);
  };
  const first = retainMorphLerpOwner(gl),
    second = retainMorphLerpOwner(gl);
  ok(created === 0, 'renderer ownership does not compile a morph helper');
  const p = getLerpPass(gl);
  p.users++;
  releaseLerpPass(gl, p);
  ok(
    deleted === 0 && getLerpPass(gl) === p && created === 1,
    'sequential morphs reuse the renderer-owned helper',
  );
  first();
  first();
  ok(deleted === 0, 'one renderer disposing twice preserves the other owner');
  p.users++;
  second();
  ok(deleted === 0, 'a live morph preserves the helper after the last renderer disposes');
  releaseLerpPass(gl, p);
  ok(
    deleted === 1 && ledgerFor(gl).snapshot().totalBytes === 0,
    'last morph disposal releases the helper and its buffer',
  );
  const standalone = getLerpPass(gl);
  standalone.users++;
  releaseLerpPass(gl, standalone);
  ok(deleted === 2, 'standalone morphs release their helper without a renderer');
  const oldOwner = retainMorphLerpOwner(gl),
    old = getLerpPass(gl);
  old.users++;
  releaseLerpPass(gl, old);
  for (const listener of listeners) listener();
  const newOwner = retainMorphLerpOwner(gl),
    fresh = getLerpPass(gl);
  oldOwner();
  ok(
    fresh !== old && getLerpPass(gl) === fresh && deleted === 2,
    'old-generation disposal cannot release or reuse a current helper',
  );
  newOwner();
  ok(
    deleted === 3 && ledgerFor(gl).snapshot().totalBytes === 0,
    'current generation releases all accounted helper bytes',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
