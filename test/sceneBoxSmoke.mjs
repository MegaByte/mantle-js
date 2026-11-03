// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sceneBoxSmoke: a scene's boxes hold its content at any size, by either route.
//
// (a) sceneToSections does not floor the content box at 1 unit per axis (a scene in small units would be fitted into a box bigger
//     than itself, unlike sceneToBundle), and a pinned viewBox under 1 unit is kept, by both routes.
// (b) The auto viewBox holds an arc by its true extent, not p0 plus or minus the radii: a large arc reaches a diameter away, and
//     the importer cuts the content box at the viewBox.
// (c) A clipper's even-odd fill rule is kept.
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const Sc = await import('../src/scene/scene.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const box = (b) => Array.from(new Float32Array(b.meta, 4, 4));
const same = (a, b, tol = 1e-5) =>
  a.length === b.length &&
  a.every((v, i) => Math.abs(v - b[i]) <= tol * Math.max(Math.abs(b[i]), 1e-3));
const red = { kind: 'solid', color: [1, 0, 0, 1] };
const rectScene = (x, y, w, h) => {
  const s = Sc.createScene();
  s.root.shapes.push({ contours: [Sc.rectContour(x, y, w, h)], fill: red });
  return s;
};

// (a)
for (const r of [
  [0, 0, 0.01, 0.01],
  [0, 0, 1e-4, 2e-4],
  [5, 5, 0.5, 0.25],
  [0, 0, 100, 0.5],
]) {
  const s = rectScene(...r);
  const direct = await Sc.sceneToSections(s),
    svg = await Sc.sceneToBundle(s);
  ok(same(box(direct), r), `direct content box of ${r}: ${box(direct)}`);
  ok(same(box(svg), r), `round-trip content box of ${r}: ${box(svg)}`);
}
{
  const s = rectScene(0, 0, 0.25, 0.25),
    pin = [0, 0, 0.5, 0.5];
  const direct = await Sc.sceneToSections(s, { viewBox: pin, preserveViewport: true }),
    svg = await Sc.sceneToBundle(s, { viewBox: pin, preserveViewport: true });
  ok(same(box(direct), pin), `a pinned viewBox under 1 is kept, direct: ${box(direct)}`);
  ok(same(box(svg), pin), `and by the round trip: ${box(svg)}`);
  ok(/viewBox="0 0 0\.5 0\.5"/.test(Sc.sceneToSvg(s, pin)), 'sceneToSvg writes it');
}
{
  // A box with nothing along one axis still gets a viewBox that renders.
  const s = Sc.createScene();
  s.root.shapes.push({
    contours: [
      Sc.polylineContour([
        [0, 0],
        [10, 0],
      ]),
    ],
    fill: null,
    pathProps: { stroke: { fill: red, halfThickness: 1 } },
  });
  const svg = await Sc.sceneToBundle(s);
  ok(svg.numShapes === 1, `a flat scene draws: ${svg.numShapes} row(s)`);
}

// (b) r = 10 from (0, 0) to (1, 0), the long way round: it reaches y = -19.99.
{
  const s = Sc.createScene();
  s.root.shapes.push({
    contours: [
      { segments: [Sc.arcSeg([0, 0], 10, 10, 0, true, true), Sc.lineSeg([1, 0])], closed: true },
    ],
    fill: red,
  });
  const b = box(await Sc.sceneToBundle(s));
  ok(b[1] < -19.9, `the large arc's far side is in the content box: y from ${b[1]}`);
  ok(b[0] + b[2] > 10.4, `and its side: x to ${b[0] + b[2]}`);
  const e = Sc.createScene();
  e.root.shapes.push({ contours: [Sc.ellipseContour(50, 40, 10, 5)], fill: red });
  ok(
    /viewBox="40 35 20 10"/.test(Sc.sceneToSvg(e)),
    `an ellipse's viewBox is its own box: ${Sc.sceneToSvg(e).match(/viewBox="[^"]*"/)[0]}`,
  );
}

// (c)
{
  const s = Sc.createScene();
  s.root.clipper = {
    shapes: [
      {
        contours: [Sc.rectContour(0, 0, 100, 100), Sc.rectContour(25, 25, 50, 50)],
        fill: { kind: 'solid', color: [1, 1, 1, 1], mode: 'evenodd' },
      },
    ],
  };
  s.root.shapes.push({ contours: [Sc.rectContour(0, 0, 100, 100)], fill: red });
  ok(
    /<clipPath[^>]*><path[^>]*clip-rule="evenodd"/.test(Sc.sceneToSvg(s)),
    'an even-odd clipper carries its rule',
  );
}

if (fail) {
  console.log(`sceneBoxSmoke: FAIL (${fail})`);
  process.exit(1);
}
console.log('sceneBoxSmoke: PASS');
process.exit(0);
