// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// exportReplaySmoke.mjs: what the frame export records from the renderer and replays (node, CPU only).
//   setScissorRect, setNodeClip (in / out) and a dstRect draw's clipToRect box are replayed per draw
//   recoverText keeps a centered / right-aligned line's position inside a layoutWidth box
//   a drawImage the GL path did not draw is not exported
import { readFileSync } from 'node:fs';
import { M, wrap, els, mkRenderer, exportDetail, check, finish } from './_exportHarness.mjs';

const { R, gl, bundle } = await mkRenderer(128, 128);
const art = await bundle(wrap('<rect id="a" width="100" height="100" fill="red"/>'));
const clip = await bundle(wrap('<rect width="30" height="30" fill="#000"/>'));
const W = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const frame = async (fn, o) => {
  R.beginFrame([1, 1, 1, 1]);
  fn();
  R.endFrame();
  return exportDetail(R, o);
};
const clipRects = (svg) =>
  els(svg, 'clipPath')
    .filter((c) => /^mantleScissor/.test(c.getAttribute('id')))
    .map((c) => {
      const r = els(c, 'rect')[0];
      return ['x', 'y', 'width', 'height'].map((k) => +r.getAttribute(k));
    });

// ──────────────────────────────────────────────────────────────────────────────────────────────
{
  let r = await frame(() => R.drawBundle(art, {}));
  check(
    'plain frame has no clip',
    clipRects(r.svg).length === 0 && !/mantleExtClip/.test(r.svg),
    r.svg,
  );

  r = await frame(() => {
    R.setScissorRect(0, 0, 40, 40);
    R.drawBundle(art, {});
  });
  // GL scissor origin is lower left: the box [0,0,40,40] is the BOTTOM-left 40 px, y = 128 - 40 from the top.
  check(
    'setScissorRect replays as a viewport-space clipPath',
    JSON.stringify(clipRects(r.svg)) === '[[0,88,40,40]]' &&
      /clip-path="url\(#mantleScissor0\)"/.test(r.svg),
    r.svg,
  );
  check(
    'the scissored draw sits inside the clip group',
    els(r.svg, 'g').some(
      (g) => g.getAttribute('clip-path') === 'url(#mantleScissor0)' && els(g, 'rect').length === 1,
    ),
    r.svg,
  );

  r = await frame(() => {
    R.setScissorRect(0, 0, 40, 40);
    R.drawBundle(art, {});
    R.clearScissorRect();
    R.drawBundle(art, { worldMatrix: W });
  });
  check(
    'only the scissored draw is clipped',
    clipRects(r.svg).length === 1 && r.drawn === 2,
    r.svg,
  );

  R.setNodeClip(art, { clipBundle: clip, mode: 'in', worldMatrix: W });
  r = await frame(() => R.drawBundle(art, {}));
  check(
    'setNodeClip in replays as a clipPath on the draw',
    els(r.svg, 'clipPath').some((c) => /^mantleExtClip/.test(c.getAttribute('id'))) &&
      /clip-path="url\(#mantleExtClip/.test(r.svg),
    r.svg,
  );
  R.setNodeClip(art, { clipBundle: clip, mode: 'out', worldMatrix: W });
  r = await frame(() => R.drawBundle(art, {}));
  check(
    'setNodeClip out replays as a mask on the draw',
    els(r.svg, 'mask').some((c) => /^mantleExtClip/.test(c.getAttribute('id'))) &&
      /mask="url\(#mantleExtClip/.test(r.svg),
    r.svg,
  );
  R.clearNodeClip(art);
  r = await frame(() => R.drawBundle(art, {}));
  check('a cleared node clip is not replayed', !/mantleExtClip/.test(r.svg), r.svg);

  r = await frame(() => R.drawBundle(art, { dstRect: [0, 0, 40, 20], fit: 'xMidYMid slice' }));
  check(
    'a dstRect draw replays its clipToRect box',
    JSON.stringify(clipRects(r.svg)) === '[[0,0,40,20]]',
    r.svg + JSON.stringify(clipRects(r.svg)),
  );
  r = await frame(() =>
    R.drawBundle(art, { dstRect: [0, 0, 40, 20], fit: 'xMidYMid slice', clipToRect: false }),
  );
  check('clipToRect:false adds no clip', clipRects(r.svg).length === 0, r.svg);

  r = await frame(
    () => {
      R.setScissorRect(0, 0, 40, 40);
      R.drawBundle(art, {});
    },
    { coordinateSpace: 'bundle' },
  );
  check(
    'bundle coordinate space adds an explicit note instead of a wrong clip',
    clipRects(r.svg).length === 0 && r.notes.some((n) => /not replayed/.test(n)),
    JSON.stringify(r.notes),
  );
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const font = new M.MantleFontAsset(
    new Uint8Array(readFileSync(new URL('./font/fixtures/roboto-regular.ttf', import.meta.url))),
  );
  const textFrame = async (style) => {
    const tb = await M.createTextBundle(gl, { font, text: 'Hello', style, retainText: true });
    return frame(() => R.drawBundle(tb.bundle, {}), { recoverText: true });
  };
  const textOf = (r) => els(r.svg, 'text')[0];
  let t = textOf(await textFrame({ fontSizePx: 32, fill: [0, 0, 0, 1] }));
  check(
    'left text stays at x=0, anchor start',
    t.getAttribute('x') === '0' && t.getAttribute('text-anchor') == null,
    t.getAttribute('x'),
  );
  t = textOf(await textFrame({ fontSizePx: 32, align: 'center', layoutWidthPx: 200 }));
  check(
    'centered text anchors at the box center',
    Math.abs(+t.getAttribute('x') - 200 / 32 / 2) < 1e-9 &&
      t.getAttribute('text-anchor') === 'middle',
    `${t.getAttribute('x')} ${t.getAttribute('text-anchor')}`,
  );
  t = textOf(await textFrame({ fontSizePx: 32, align: 'right', layoutWidthPx: 200 }));
  check(
    'right-aligned text anchors at the box right edge',
    Math.abs(+t.getAttribute('x') - 200 / 32) < 1e-9 && t.getAttribute('text-anchor') === 'end',
    `${t.getAttribute('x')} ${t.getAttribute('text-anchor')}`,
  );
  t = textOf(await textFrame({ fontSizePx: 32, align: 'center' }));
  check(
    'centered text with no layout box keeps the ink-tight origin',
    t.getAttribute('x') === '0' && t.getAttribute('text-anchor') == null,
  );
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQ0TjxHwADXAIEAtgdbwAAAABJRU5ErkJggg==';
  let ok;
  const r = await frame(() => {
    ok = R.drawImage(png, { dstRect: [10, 10, 50, 50] });
  });
  check('precondition: GL drawImage(string) declines', ok === false, ok);
  check(
    'a declined drawImage is not exported',
    !/<image/.test(r.svg) && r.drawn === 0 && r.skipped === 0,
    JSON.stringify({ d: r.drawn, s: r.skipped }),
  );
}

finish('exportReplaySmoke');
