// sceneApiSmoke.mjs — programmatic-scene API: builds bundles WITHOUT
// writing SVG strings by hand and verifies the imported geometry
// matches an equivalent direct SVG run.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import {
  createScene, sceneToBundle, sceneToSvg,
  rectContour, ellipseContour, polygonContour,
  arcContour, arcSeg,
} from '../../src/scene/scene.js';
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const ok   = (msg) => console.log('ok', msg);
const fail = (msg) => { failures++; console.error('FAIL', msg); };
const approxEq = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const bboxApproxEq = (a, b, eps = 1e-2) =>
  approxEq(a[0], b[0], eps) && approxEq(a[1], b[1], eps) &&
  approxEq(a[2], b[2], eps) && approxEq(a[3], b[3], eps);

// ---- T1: single-rect scene equivalent to <rect> SVG -----------------
{
  const scene = createScene();
  scene.root.shapes.push({
    contours: [rectContour(10, 10, 80, 80)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  const fromScene = await sceneToBundle(scene);
  const fromSvg = await importSvg(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 80 80">
  <rect x="10" y="10" width="80" height="80" fill="#ff0000"/>
</svg>`);
  if (fromScene.numShapes !== fromSvg.numShapes)
    fail(`T1 rect: numShapes mismatch ${fromScene.numShapes} vs ${fromSvg.numShapes}`);
  else if (!bboxApproxEq(fromScene.globalBBox, fromSvg.globalBBox))
    fail(`T1 rect: globalBBox mismatch ${fromScene.globalBBox} vs ${fromSvg.globalBBox}`);
  else ok(`T1 rect scene → bundle (numShapes=${fromScene.numShapes}, bbox=${fromScene.globalBBox.map(v=>v.toFixed(1))})`);
}

// ---- T2: ellipse scene equivalent to <circle> SVG -------------------
{
  const scene = createScene();
  scene.root.shapes.push({
    contours: [ellipseContour(50, 50, 30, 30)],
    fill: { kind: 'solid', color: [0, 0, 1, 1] },
  });
  const fromScene = await sceneToBundle(scene);
  const fromSvg = await importSvg(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="30" fill="#0000ff"/>
</svg>`);
  // BBoxes may differ slightly (scene viewBox shrink-wraps the bezier
  // controls; circle SVG uses fill-tight bbox). Compare width/height.
  const sceneW = fromScene.globalBBox[2], sceneH = fromScene.globalBBox[3];
  const svgW   = fromSvg.globalBBox[2],   svgH   = fromSvg.globalBBox[3];
  if (!approxEq(sceneW, svgW, 0.1) || !approxEq(sceneH, svgH, 0.1))
    fail(`T2 ellipse: bbox size mismatch (${sceneW},${sceneH}) vs (${svgW},${svgH})`);
  else if (fromScene.numShapes !== 1)
    fail(`T2 ellipse: expected 1 shape, got ${fromScene.numShapes}`);
  else ok(`T2 ellipse scene → bundle (size=${sceneW.toFixed(1)}×${sceneH.toFixed(1)})`);
}

// ---- T3: multi-shape scene + nested children + transform -----------
{
  const scene = createScene();
  scene.root.shapes.push({
    contours: [rectContour(0, 0, 100, 100)],
    fill: { kind: 'solid', color: [0.5, 0.5, 0.5, 1] },
  });
  scene.root.children.push({
    transform: [1, 0, 0, 1, 50, 50],   // translate (50, 50)
    shapes: [{
      contours: [polygonContour([[0,0], [20,0], [10,20]])],
      fill: { kind: 'solid', color: [1, 1, 0, 1] },
    }],
  });
  const fromScene = await sceneToBundle(scene);
  // Expect 2 shapes (rect + translated triangle). The triangle should
  // appear at (50..70, 50..70) after applying the parent translate.
  if (fromScene.numShapes !== 2)
    fail(`T3 multi-shape: expected 2 shapes, got ${fromScene.numShapes}`);
  else if (fromScene.globalBBox[2] < 70 || fromScene.globalBBox[3] < 70)
    fail(`T3 multi-shape: viewBox should contain translated triangle (up to ~70,70). Got ${fromScene.globalBBox}`);
  else ok(`T3 multi-shape + child transform: 2 shapes, bbox=${fromScene.globalBBox.map(v=>v.toFixed(1))}`);
}

// ---- T4: gradient fill via scene API -------------------------------
{
  const scene = createScene();
  scene.root.shapes.push({
    contours: [rectContour(0, 0, 100, 100)],
    fill: {
      kind: 'gradient',
      type: 'linear',
      stops: [
        { position: 0, color: [1, 0, 0, 1] },
        { position: 1, color: [0, 0, 1, 1] },
      ],
    },
  });
  const fromScene = await sceneToBundle(scene);
  // Gradient bundles ship a gradient table; non-gradient bundles do not.
  if (!fromScene.gradients || fromScene.gradients.byteLength === 0)
    fail(`T4 gradient: bundle missing gradient table`);
  else ok(`T4 gradient scene → bundle has gradient table (${fromScene.gradients.byteLength} bytes)`);
}

// ---- T5: stroke on a contour ---------------------------------------
{
  const scene = createScene();
  scene.root.shapes.push({
    contours: [rectContour(10, 10, 80, 80)],
    fill: null,   // no fill, stroke only
    pathProps: {
      stroke: {
        fill: { kind: 'solid', color: [0, 1, 0, 1] },
        halfThickness: 2,
        corners: 'round',
        head: 'square',
      },
    },
  });
  const svg = sceneToSvg(scene);
  if (!/stroke="#00ff00"/.test(svg))
    fail(`T5 stroke: emitted SVG missing stroke color (got: ${svg.slice(0, 200)})`);
  else if (!/stroke-width="4"/.test(svg))
    fail(`T5 stroke: emitted SVG missing stroke-width="4" (halfThickness=2 → width=4)`);
  else if (!/stroke-linejoin="round"/.test(svg))
    fail(`T5 stroke: emitted SVG missing stroke-linejoin="round"`);
  else if (!/stroke-linecap="square"/.test(svg))
    fail(`T5 stroke: emitted SVG missing stroke-linecap="square"`);
  else ok(`T5 stroke params plumbed end-to-end via sceneToSvg`);
  // Also round-trip through the importer to confirm it accepts it.
  const fromScene = await sceneToBundle(scene);
  if (!(fromScene.numShapes >= 1))
    fail(`T5 stroke: bundle has no shapes`);
  else ok(`T5 stroke bundle imported (numShapes=${fromScene.numShapes})`);
}

// ---- T6: even-odd fill rule ---------------------------------------
{
  // Two concentric rect contours, outer + inner-hole; even-odd should
  // carve the middle out.
  const scene = createScene();
  scene.root.shapes.push({
    contours: [
      rectContour(0, 0, 100, 100),
      rectContour(25, 25, 50, 50),
    ],
    fill: { kind: 'solid', color: [1, 0, 0, 1], mode: 'evenodd' },
  });
  const svg = sceneToSvg(scene);
  if (!/fill-rule="evenodd"/.test(svg))
    fail(`T6 evenodd: emitted SVG missing fill-rule (got: ${svg.slice(0,200)})`);
  else ok(`T6 fill-rule evenodd serialized`);
}

// ---- T7a: SceneShape.id round-trips to bundle.shapeIds -------------
{
  const scene = createScene();
  scene.root.shapes.push({
    id: 'bg',
    contours: [rectContour(0, 0, 100, 100)],
    fill: { kind: 'solid', color: [1, 1, 1, 0.5] },
  });
  scene.root.shapes.push({
    id: 'fill',
    contours: [ellipseContour(50, 50, 30, 30)],
    fill: { kind: 'solid', color: [0.2, 0.2, 0.2, 1] },
  });
  const svg = sceneToSvg(scene);
  if (!/<path[^>]+id="bg"/.test(svg) || !/<path[^>]+id="fill"/.test(svg))
    fail(`T7a id attribute not emitted on <path> (got: ${svg})`);
  else ok(`T7a SceneShape.id emits id="..." on <path>`);
  const sections = await sceneToBundle(scene);
  const ids = sections.shapeIds || [];
  // Each shape may emit two meta rows (fill + stroke); the importer
  // tags only the fill row with the user id and the stroke row with
  // an `_stroke` suffix or empty. We just want the friendly ids
  // present in the list.
  const hasBg = ids.includes('bg');
  const hasFill = ids.includes('fill');
  if (!hasBg || !hasFill)
    fail(`T7a shapeIds missing 'bg' / 'fill' (got: ${JSON.stringify(ids)})`);
  else ok(`T7a sections.shapeIds carries friendly ids: ${JSON.stringify(ids)}`);
}

// ---- T7b: id attribute is escaped against quote / amp injection ----
{
  const scene = createScene();
  scene.root.shapes.push({
    id: 'a"b&c<d',
    contours: [rectContour(0, 0, 10, 10)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  const svg = sceneToSvg(scene);
  if (!/id="a&quot;b&amp;c&lt;d"/.test(svg))
    fail(`T7b id attribute escaping missing entities (got: ${svg.slice(0, 200)})`);
  else ok(`T7b id attribute escapes " & < safely`);
}

// ---- T8: ellipseContour emits NATIVE arcs (A), not 4 cubics --------
// ellipseContour emits 2 SVG arc commands so the importer keeps native
// SEG_ARC segments end-to-end: smaller curve buffer + no cardinal-axis
// cancellation (no cubic apex vertices that share dX/dt=0).
{
  const scene = createScene();
  scene.root.shapes.push({
    contours: [ellipseContour(50, 50, 50, 50)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  const svg = sceneToSvg(scene);
  const arcCount = (svg.match(/A\s*\d/g) || []).length;
  const cubicCount = (svg.match(/C\s*\d/g) || []).length;
  if (arcCount !== 2 || cubicCount !== 0)
    fail(`T8 ellipseContour should emit 2 A's + 0 C's; got ${arcCount} A's + ${cubicCount} C's. SVG: ${svg}`);
  else ok(`T8 ellipseContour emits 2 native SVG arcs (no cubic approximation)`);
}

// ---- T9: arcContour helper + arcSeg primitive ----------------------
// arcContour assembles arbitrary elliptical-arc paths (rings, pie
// wedges, rounded-rect corners) so consumers don't have to choose
// between cubic approximation and hand-written SVG strings.
{
  const c = arcContour([
    arcSeg([0, 50], 50, 50, 0, false, true),    // start at (0,50), arc to next p0
    arcSeg([100, 50], 50, 50, 0, false, true),  // continue to next p0 → wraps to first
  ], true);
  if (c.segments.length !== 2 || c.segments[0].kind !== 'arc')
    fail(`T9 arcContour shape wrong: ${JSON.stringify(c)}`);
  else ok(`T9 arcContour returns { segments, closed } with kind='arc' segments`);
  const scene = createScene();
  scene.root.shapes.push({
    contours: [c],
    fill: { kind: 'solid', color: [0, 0, 1, 1] },
  });
  const svg = sceneToSvg(scene);
  if (!/A50 50 0 0 1 100 50A50 50 0 0 1 0 50Z/.test(svg))
    fail(`T9 emitted SVG missing expected 'A' path: ${svg}`);
  else ok(`T9 arcContour → sceneToSvg emits SVG A commands`);
  // Round-trip through importer too.
  const sections = await sceneToBundle(scene);
  if (sections.numShapes < 1)
    fail(`T9 arcContour bundle has no shapes`);
  else ok(`T9 arcContour round-trips through importer (numShapes=${sections.numShapes})`);
}

// ---- T7: scene API is exposed from the public entry point ----------
{
  const mod = await import('../../src/index.js');
  const expected = ['createScene', 'sceneToBundle', 'sceneToSvg',
                    'rectContour', 'ellipseContour', 'polygonContour',
                    'arcContour', 'arcSeg', 'linearSeg'];
  const missing = expected.filter(k => typeof mod[k] !== 'function');
  if (missing.length) fail(`T7 missing public exports: ${missing.join(', ')}`);
  else ok(`T7 all ${expected.length} scene-API symbols exported from @kontek/mantle`);
}

console.log();
console.log(failures === 0 ? 'SCENE-API PASS' : `SCENE-API FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
