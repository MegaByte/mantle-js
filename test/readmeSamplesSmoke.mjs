// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// readmeSamplesSmoke.mjs: the README's JavaScript samples are executable, not decorative (node, CPU only).
// Every sample that imports from the package runs for real against the fake GL, with the shader dict, the
// canvas, `svgText` and `fetch` stubbed; a sample with no import is a fragment and is reported by name.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { xmldom } from './_domShim.mjs';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { check, finish } from './_exportHarness.mjs';

const root = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const blocks = [...readme.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
check('the README has JavaScript samples', blocks.length >= 3, blocks.length);

const F = createFakeGl({ width: 128, height: 128 });
globalThis.canvas = { getContext: () => F.gl, width: 128, height: 128 };
globalThis.svgText =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="50" height="50" fill="red"/></svg>';
const fontBytes = readFileSync(new URL('test/font/fixtures/roboto-regular.ttf', root));
globalThis.fetch = async () => ({
  arrayBuffer: async () =>
    fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength),
});
globalThis.DOMParser = xmldom.DOMParser;
globalThis.XMLSerializer = xmldom.XMLSerializer;

const exportsMap = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).exports;

// A sample is run when it builds a renderer from the package root; it is a fragment otherwise.
const RUNNABLE = [/from '@kontek\/mantle';[\s\S]*createRenderer\(/];
// Every sample that imports from the package is run; one without imports is a fragment and is reported.
let ran = 0;
for (let i = 0; i < blocks.length; i++) {
  const text = blocks[i];
  const firstLine = text.split('\n')[0].slice(0, 60);
  if (!/from '@kontek\/mantle/.test(text)) {
    console.log(`INFO README js #${i} is a fragment, not run: ${firstLine}`);
    continue;
  }
  const src = text.replace(/from '@kontek\/mantle(\/[\w/]+)?'/g, (m, sub) => {
    const target = exportsMap[sub ? '.' + sub : '.'];
    if (!target)
      throw new Error(
        `README imports '@kontek/mantle${sub || ''}', which package.json does not export`,
      );
    return `from '${pathToFileURL(new URL(target.default, root).pathname).href}'`;
  });
  const err = await import(
    'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
  ).then(
    () => null,
    (e) => e,
  );
  check(`README js #${i} runs (${firstLine})`, err === null, err && err.message);
  ran++;
}
check('the Quick start, Rendering text and font samples all ran', ran >= 4, ran);
finish('readmeSamplesSmoke');
