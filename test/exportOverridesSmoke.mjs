// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// exportOverridesSmoke.mjs: per-shape overrides through the native scene and the frame export (node, CPU only).
//   a fill row and a stroke row of one shape: the stroke row's identity tint must not re-apply the
//          authored fill over the fill row's override (native morph and morph-pose export)
//   localPosition / localRotation / localScale compose with the authored transform
//   NaN / Infinity in worldMatrix, clearColor and colorMatrix never reach the markup
import {
  M,
  wrap,
  imp,
  dom,
  parse,
  els,
  exportLog,
  mkRenderer,
  exportDetail,
  check,
  finish,
} from './_exportHarness.mjs';

const fillOf = (svg, id) => {
  const el = els(svg).find((e) => e.getAttribute('id') === id);
  return el && el.getAttribute('fill');
};

// ── native morph, fill + stroke ──────────────────────────────────────────────────────────
{
  const A = await imp(
    wrap(
      '<rect id="c" x="10" y="10" width="20" height="20" fill="#0000ff" stroke="#000" stroke-width="2"/>',
    ),
  );
  const B = await imp(
    wrap(
      '<rect id="c" x="10" y="10" width="20" height="40" fill="#ff00ff" stroke="#000" stroke-width="6"/>',
    ),
  );
  const nm = M.createNativeMorph(A, B);
  nm.setT(1);
  const host = dom.createElement('div');
  const scene = M.createNativeScene(host, { document: dom });
  scene.setViewport(100, 100);
  scene.beginFrame([1, 1, 1, 1]);
  scene.drawBundle(nm.bundle, { overrides: nm.overrides });
  scene.endFrame();
  const el = els(scene.svg).find((e) =>
    (e.getAttribute('data-oid') || e.getAttribute('id') || '').startsWith('c'),
  );
  check(
    'native morph t=1 fill reaches the target fill',
    el && el.getAttribute('fill') === 'rgba(255,0,255,1)',
    el && el.getAttribute('fill'),
  );
  check(
    'native morph t=1 stroke-width reaches the target',
    el && el.getAttribute('stroke-width') === '6',
    el && el.getAttribute('stroke-width'),
  );
  scene.dispose();
}
// ── morph-pose export through the real renderer ──────────────────────────────────────────
{
  const { R, gl, bundle } = await mkRenderer();
  const a = await bundle(
    wrap('<path id="c" d="M10 10H30V30H10Z" fill="#0000ff" stroke="#000" stroke-width="2"/>'),
  );
  const b = await bundle(
    wrap('<path id="c" d="M10 10H30V50H10Z" fill="#ff00ff" stroke="#000" stroke-width="6"/>'),
  );
  const m = M.createShapeMorph(gl, a, b);
  m.setT(1);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(m, {});
  R.endFrame();
  const r = await exportDetail(R);
  check(
    'morph-pose export t=1 fill is the target fill',
    /fill="rgba\(255,0,255,1\)"/.test(r.svg),
    r.svg,
  );
}

// ── localPosition composes with the authored transform ───────────────────────────────────
{
  const b = await imp(
    wrap(
      '<rect id="a" width="10" height="10" fill="red" transform="translate(50 20)"/>' +
        '<rect id="b" width="10" height="10" fill="blue" transform="translate(70 20) scale(2)"/>',
    ),
  );
  const ov = M.createNativeOverrideTable(b);
  ov.set('a', { localPosition: [0, 10] });
  ov.set('b', { localRotation: 0.5 });
  const r = exportLog([{ bundle: b, opts: { overrides: ov } }]);
  const t = (id) =>
    els(r.svg, 'rect')
      .find((e) => e.getAttribute('id') === id)
      .getAttribute('transform');
  check(
    'override is prepended to the authored translate',
    /^translate\(0 10\) rotate\(0\) scale\(1 1\) translate\(50 20\)$/.test(t('a')),
    t('a'),
  );
  check(
    'rotation keeps the authored translate and scale',
    /rotate\(28\.6\d*\) scale\(1 1\) translate\(70 20\) scale\(2\)$/.test(t('b')),
    t('b'),
  );
  // Re-drawing the same scene must not compound the override onto itself.
  const host = dom.createElement('div');
  const scene = M.createNativeScene(host, { document: dom });
  scene.setViewport(100, 100);
  const draw = () => {
    scene.beginFrame([1, 1, 1, 1]);
    scene.drawBundle(b, { overrides: ov });
    scene.endFrame();
  };
  draw();
  ov.set('a', { localPosition: [0, 11] });
  draw();
  draw();
  const el = els(scene.svg, 'rect').find((e) =>
    (e.getAttribute('data-oid') || e.getAttribute('id') || '').startsWith('a'),
  );
  check(
    'repeated frames do not compound',
    el.getAttribute('transform') === 'translate(0 11) rotate(0) scale(1 1) translate(50 20)',
    el.getAttribute('transform'),
  );
  scene.dispose();
}

// ── non-finite numbers ───────────────────────────────────────────────────────────────────
{
  const b = await imp(wrap('<rect id="a" width="10" height="10" fill="red"/>'));
  const bad = /NaN|Infinity/;
  let r = exportLog([{ bundle: b, opts: { worldMatrix: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] } }]);
  check(
    'NaN worldMatrix: no NaN in the markup, draw skipped with a note',
    !bad.test(r.svg) && r.skipped === 1 && r.notes.some((n) => /non-finite worldMatrix/.test(n)),
    r.svg + JSON.stringify(r.notes),
  );
  r = exportLog([{ bundle: b, opts: { worldMatrix: [1, 0, 0, 0, 1, 0, Infinity, 0, 1] } }]);
  check('Infinity worldMatrix skipped', !bad.test(r.svg) && r.skipped === 1, r.svg);
  r = exportLog([{ bundle: b, opts: {} }], { clearColor: [NaN, 0, 0, 1] });
  check(
    'NaN clearColor written as a finite color, with a note',
    !bad.test(r.svg) && r.notes.some((n) => /clearColor/.test(n)),
    r.svg + JSON.stringify(r.notes),
  );
  r = exportLog([{ bundle: b, opts: { colorMatrix: new Array(16).fill(NaN) } }]);
  check(
    'NaN colorMatrix skipped with a note',
    !bad.test(r.svg) && r.skipped === 1 && r.notes.some((n) => /colorMatrix/.test(n)),
    r.svg,
  );
  // The native scene on its own hides a draw it cannot place.
  const host = dom.createElement('div');
  const scene = M.createNativeScene(host, { document: dom });
  scene.setViewport(100, 100);
  scene.beginFrame([NaN, 0, 0, 1]);
  scene.drawBundle(b, { worldMatrix: new Float32Array([NaN, 0, 0, 0, 1, 0, 0, 0, 1]) });
  scene.endFrame();
  const out = new globalThis.XMLSerializer().serializeToString(scene.svg);
  check(
    'native scene writes no NaN and hides the draw',
    !bad.test(out) && /display:\s*none/.test(out),
    out,
  );
  scene.dispose();
}

finish('exportOverridesSmoke');
