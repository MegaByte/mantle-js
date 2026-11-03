// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverLayoutDrawListSmoke: a handle lays its cover buffer out for the draw list it walks (node, fake GL, the real occlusion worker).
// The cover pass merges chunks into one drawArrays only while each starts where the last ended, so a row the occlusion cull drops
// between two painted rows would end the run. The handle moves the chunks the list leaves out behind the painted ones
// (renderer.js _layCoverForDrawList, coverQuadChunks.js planCoverLayout). The fake GL's buffers are shadowed, so every frame's
// cover draws can be read back as the vertices they consumed. Each state must draw exactly the vertices the draw list names, in
// list order (what one draw per run of the bundle's own layout draws), in one call (three when a stroke strip, which sits behind the
// quads, falls between two of them):
//   the inline cull at build, the worker cull landing late, an override that retires the cull, the override cleared, a kept row
//   revealed and hidden again (the layout stays put: no upload at either), and stroke strips, which keep their offsets.
import { M, wrap, imp, mkRenderer, check, finish } from './_exportHarness.mjs';

const SCENE = wrap(
  '<rect id="left" x="2" y="40" width="10" height="10" fill="#0f0"/>' +
    '<rect id="twinUnder" x="14" y="14" width="20" height="20" fill="#f0f"/>' +
    '<rect id="twinOver" x="14" y="14" width="20" height="20" fill="#0ff"/>' +
    '<rect id="under" x="50" y="50" width="10" height="10" fill="#00f"/>' +
    '<rect id="over" x="40" y="40" width="40" height="40" fill="#f00"/>' +
    '<rect id="ghost" x="85" y="5" width="10" height="10" fill="#000" display="none"/>' +
    '<path id="line" d="M5 95 C 30 70 60 120 95 90" fill="none" stroke="#123" stroke-width="3"/>' +
    '<rect id="right" x="88" y="40" width="10" height="10" fill="#ff0"/>',
);

async function arm(label, ropts, viaDrawBundle) {
  const { R, gl } = await mkRenderer(512, 512, { captureFrames: false, ...ropts });
  // Shadow every ARRAY_BUFFER and remember which buffers each VAO reads, so a draw can be read back as the vertices it consumed.
  const shadow = new Map(),
    vaoBufs = new Map(),
    coverBufs = new Set();
  let b = null,
    bound = null,
    vao = null,
    subBytes = 0,
    fullUploads = 0;
  const bytesOf = (d) => new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  const {
    bindBuffer,
    bufferData,
    bufferSubData,
    bindVertexArray,
    vertexAttribPointer,
    drawArrays,
  } = gl;
  gl.bindBuffer = (t, buf) => {
    if (t === gl.ARRAY_BUFFER) bound = buf;
    return bindBuffer(t, buf);
  };
  gl.bufferData = (t, d, u) => {
    if (t === gl.ARRAY_BUFFER && bound) {
      shadow.set(bound, typeof d === 'number' ? new Uint8Array(d) : bytesOf(d).slice());
      if (b && d === b.coverQuadVboFloats) {
        coverBufs.add(bound);
        fullUploads++;
      }
    }
    return bufferData(t, d, u);
  };
  gl.bufferSubData = (t, off, d) => {
    if (t === gl.ARRAY_BUFFER && bound) {
      shadow.get(bound).set(bytesOf(d), off);
      if (coverBufs.has(bound) || [...vaoBufs.values()].some((v) => v[7] === bound))
        subBytes += d.byteLength;
    }
    return bufferSubData(t, off, d);
  };
  gl.bindVertexArray = (v) => {
    vao = v;
    return bindVertexArray(v);
  };
  gl.vertexAttribPointer = (i, ...rest) => {
    if (vao && (i === 0 || i === 7)) {
      if (!vaoBufs.has(vao)) vaoBufs.set(vao, {});
      vaoBufs.get(vao)[i] = bound;
    }
    return vertexAttribPointer(i, ...rest);
  };
  let drawn = [],
    covers = 0;
  gl.drawArrays = (m, f, c) => {
    const at = vaoBufs.get(vao);
    if (at && coverBufs.has(at[0])) {
      covers++;
      const v = shadow.get(at[0]),
        s = shadow.get(at[7]);
      drawn.push(v.subarray(f * 48, (f + c) * 48), s.subarray(f * 4, (f + c) * 4));
    }
    return drawArrays(m, f, c);
  };
  b = M.createBundle(gl, await imp(SCENE, { keepHidden: true }));
  const h = viaDrawBundle ? null : R.createBundleHandle(b);
  const ov = M.createOverrideTable(gl, b);
  // What the list names: each painted chunk's vertices from the bundle's own planes, in list order.
  const expected = () => {
    const v = [],
      s = [];
    for (const op of b.drawList) {
      const c = op.chunk;
      if (!c) continue;
      const strip = c._stripOn && c._strip;
      const at = strip ? strip.start : c.vboStart,
        n = strip ? strip.count : c.count;
      v.push(bytesOf(b.coverQuadVboFloats.subarray(at * 12, (at + n) * 12)));
      s.push(bytesOf(b.hybridShapeIdxVboFloats.subarray(at, at + n)));
    }
    return Buffer.concat([...v, ...s]);
  };
  const frame = (opts) => {
    drawn = [];
    covers = 0;
    subBytes = 0;
    fullUploads = 0;
    R.beginFrame([1, 1, 1, 1]);
    if (h) h.draw(opts);
    else R.drawBundle(b, opts);
    R.endFrame();
    const v = drawn.filter((_, i) => i % 2 === 0),
      s = drawn.filter((_, i) => i % 2 === 1);
    const same = Buffer.compare(Buffer.concat([...v, ...s]), expected()) === 0;
    return { covers, same, subBytes, fullUploads };
  };
  const quadBytes = b.coverQuadChunks.reduce((n, c) => n + c.count, 0) * 52;
  const strips = !!(b._stripChunks && b._stripChunks.length);
  // the strip sits behind the quads, so the stroke row between two quads splits the run once on each side
  const runs = ropts.strokeStrip === 'on' ? 3 : 1;
  const one = (st) => st.covers === runs;
  const say = (st) => `${st.covers} draws, ${st.subBytes} B moved, ${st.fullUploads} whole uploads`;

  check(
    `${label}: the coincident layer is cut at build`,
    !!b._culledShapes && b._culledShapes.size === 1,
  );
  check(`${label}: the worker half is still out`, b._occlusionCullPending === true);
  check(`${label}: the bundle carries stroke strips`, strips);
  let st = frame({});
  const stripsOn = b._stripChunks.some((c) => c._stripOn);
  check(
    `${label}: the stroke row draws its ${ropts.strokeStrip === 'on' ? 'strip' : 'quad'}`,
    stripsOn === (ropts.strokeStrip === 'on'),
  );
  check(`${label}: inline cull: the draws read the listed vertices`, st.same, say(st));
  check(`${label}: inline cull: ${runs} run(s)`, one(st), say(st));
  while (b._occlusionCullPending) await new Promise((r) => setTimeout(r, 10)); // the node lane's per-test cap is the deadline
  check(`${label}: the worker cull landed`, b._culledShapes.size === 2);
  st = frame({});
  check(`${label}: late cull: the draws read the listed vertices`, st.same, say(st));
  check(`${label}: late cull: ${runs} run(s)`, one(st), say(st));
  check(
    `${label}: late cull: only the moved span is uploaded`,
    st.fullUploads === 0 && st.subBytes > 0 && st.subBytes <= quadBytes,
    say(st),
  );
  st = frame({});
  check(
    `${label}: a second frame uploads nothing`,
    st.subBytes === 0 && st.fullUploads === 0,
    say(st),
  );
  ov.set('over', { visibility: 0 });
  st = frame({ overrides: ov });
  check(`${label}: occluder hidden: the cull is retired`, b._cullRetired === true);
  check(`${label}: occluder hidden: the draws read the listed vertices`, st.same, say(st));
  check(`${label}: occluder hidden: ${runs} run(s)`, one(st), say(st));
  ov.set('over', {});
  st = frame({ overrides: ov });
  check(`${label}: override cleared: the draws read the listed vertices`, st.same, say(st));
  ov.update('ghost', { reveal: true });
  st = frame({ overrides: ov });
  check(
    `${label}: kept row revealed: it is drawn`,
    b.drawList.some((op) => op.shapeIdx === 5),
  );
  check(`${label}: kept row revealed: the draws read the listed vertices`, st.same, say(st));
  check(
    `${label}: kept row revealed: the layout stays put`,
    st.subBytes === 0 && st.fullUploads === 0,
    say(st),
  );
  ov.update('ghost', { reveal: false });
  st = frame({ overrides: ov });
  check(`${label}: kept row hidden again: the draws read the listed vertices`, st.same, say(st));
  check(
    `${label}: kept row hidden again: ${runs} run(s), no upload`,
    one(st) && st.subBytes === 0 && st.fullUploads === 0,
    say(st),
  );
  Object.assign(gl, {
    bindBuffer,
    bufferData,
    bufferSubData,
    bindVertexArray,
    vertexAttribPointer,
    drawArrays,
  });
}

await arm('handle', {}, false);
await arm('drawBundle, strips', { strokeStrip: 'on' }, true);
finish('coverLayoutDrawListSmoke');
process.exit(0);
