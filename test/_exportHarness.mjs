// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _exportHarness.mjs: run the native scene and the REAL createRenderer frame export in node, with no
// GPU and no browser. A DOM shim over xmldom supplies the document; _fakeGl.mjs supplies the GL
// context, so renderer.exportFrameSVG() replays the frame the renderer recorded through the native
// scene exactly as in a browser. What it cannot show is pixels (the render lane does that).
import { xmldom, doc } from './_domShim.mjs';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

globalThis.DOMParser = xmldom.DOMParser;
globalThis.XMLSerializer = xmldom.XMLSerializer;
if (!globalThis.document) globalThis.document = doc;

export const dom = doc;
export const M = await import('../src/index.js');
export const { exportFrameToSvg } = await import('../src/fallback/frameExport.js');

export const wrap = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;
export const imp = (svg, o = {}) => M.importSvg(svg, { retainSource: true, ...o });
export const parse = (s) => new xmldom.DOMParser().parseFromString(s, 'image/svg+xml');
/** Every descendant element of a node (or of a serialized document) matching a simple selector, as an array. */
export const els = (root, sel = '*') =>
  Array.from((typeof root === 'string' ? parse(root).documentElement : root).querySelectorAll(sel));

/** Export a frame log directly (no renderer): [{ bundle, opts }] -> { svg, drawn, skipped, notes }. */
export function exportLog(entries, p = {}) {
  return exportFrameToSvg({
    document: dom,
    viewport: [100, 100],
    coordinateSpace: 'bundle',
    frameLog: entries.map((e) =>
      e.kind ? e : { kind: 'bundle', bundle: e.bundle, opts: e.opts || {} },
    ),
    ...p,
  });
}

/** The real renderer on the fake GL with frame capture on. */
export async function mkRenderer(W = 128, H = 128, ropts = {}) {
  const F = createFakeGl({ width: W, height: H });
  const R = M.createRenderer(F.gl, taggedShaderSources(), { captureFrames: true, ...ropts });
  if (R.ready) await R.ready;
  R.setViewport(W, H);
  return { F, R, gl: F.gl, bundle: async (svg, o) => M.createBundle(F.gl, await imp(svg, o)) };
}
export const exportDetail = (R, o = {}) => R.exportFrameSVG({ document: dom, detail: true, ...o });

let fails = 0;
export function check(name, ok, detail) {
  if (ok) console.log('PASS', name);
  else {
    fails++;
    console.log('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 400));
  }
}
export function finish(label) {
  if (fails) {
    console.log(`${label}: ${fails} FAILED`);
    process.exit(1);
  }
  console.log(`${label}: ok`);
}
