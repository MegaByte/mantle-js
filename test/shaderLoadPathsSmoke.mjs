// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderLoadPathsSmoke.mjs - the shader load paths work or fail loudly.
//
//  * loadShaders() / bundleShaders.fromPackage() with no URL return the bundled module's text, which is exactly
//    generated/*.glsl, with no fetch and no fs (so it behaves the same under every bundler).
//  * loadShaders(file: URL) reads through node:fs (undici's fetch refuses file:).
//  * loadShaders(http base) fetches; a 404 host, and an SPA-fallback host answering 200 text/html, THROW with the
//    URL and status instead of returning HTML as GLSL.
//  * the createRenderer error does not name a function that does not exist.
//
// GL-free. Uses a loopback HTTP server only.

import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bundleShaders,
  loadShaders,
  shaderKeysFor,
  SHADER_FILENAMES,
} from '../src/shaders/index.js';
import { Features } from '../src/bundle/featureSet.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHADERS = path.resolve(HERE, '../src/shaders');
const GEN = path.join(SHADERS, 'generated');
const gen = (file) => readFileSync(path.join(GEN, file), 'utf8');

// 1. Bundled default.
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the bundled path must not fetch');
  };
  try {
    const all = await bundleShaders.fromPackage();
    const bad = SHADER_FILENAMES.filter(([key, file]) => all[key] !== gen(file));
    bad.length === 0 && Object.keys(all).length === SHADER_FILENAMES.length
      ? ok(
          `fromPackage() returns all ${SHADER_FILENAMES.length} shaders, byte-equal to generated/*.glsl`,
        )
      : fail(`fromPackage() differs from generated for ${bad.map((b) => b[0]).join(',')}`);

    const spec = { features: 0n };
    const lean = await loadShaders(undefined, spec);
    const want = [...shaderKeysFor(spec)].sort().join();
    Object.keys(lean).sort().join() === want
      ? ok(`spec trims the dict to core (${want.split(',').length} keys)`)
      : fail('spec dict differs from shaderKeysFor');
    !('maskBakeVert' in lean) && !('maskBakeFrag' in lean)
      ? ok('resource-free assets skip the analytic resource-bake program')
      : fail('core still loads resource baking');
    for (const feature of [Features.Clips, Features.Masks, Features.VectorPattern]) {
      const selected = await loadShaders({ features: feature });
      selected.maskBakeVert === all.maskBakeVert && selected.maskBakeFrag === all.maskBakeFrag
        ? ok(`resource feature ${feature} includes both bake stages`)
        : fail(`missing bake stages for ${feature}`);
    }
    const explicitBake = await loadShaders({
      features: 0n,
      include: ['maskBakeVert', 'maskBakeFrag'],
    });
    explicitBake.maskBakeVert === all.maskBakeVert && explicitBake.maskBakeFrag === all.maskBakeFrag
      ? ok('explicit resource-bake inclusion remains available')
      : fail('explicit bake inclusion lost');
    const viaObj = await loadShaders({ include: ['feBlendFrag'] });
    'feBlendFrag' in viaObj && 'fillFrag' in viaObj
      ? ok('loadShaders(spec) reads a lone object as the spec')
      : fail('loadShaders(spec) ignored');
    const fp = await bundleShaders.fromPackage({ features: 0n });
    Object.keys(fp).length === Object.keys(lean).length
      ? ok('fromPackage(spec) matches loadShaders(undefined, spec)')
      : fail('fromPackage(spec) differs');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// 2. file: URL in Node.
{
  const base = pathToFileURL(SHADERS + path.sep).href;
  try {
    const d = await loadShaders(base, { features: 0n });
    const bad = Object.keys(d).filter(
      (k) => d[k] !== gen(SHADER_FILENAMES.find(([key]) => key === k)[1]),
    );
    bad.length === 0
      ? ok(`loadShaders(file: URL) reads ${Object.keys(d).length} shaders via fs`)
      : fail('file: URL text differs for ' + bad);
  } catch (e) {
    fail('loadShaders(file: URL) threw: ' + e.message);
  }
  try {
    await loadShaders(pathToFileURL(path.join(HERE, 'no-such-dir') + path.sep).href);
    fail('a missing file: base returned a result');
  } catch (e) {
    /cannot load shaders from|failed to load/.test(e.message)
      ? ok('missing file: base throws: ' + e.message.slice(0, 80))
      : fail('missing file: base error: ' + e.message);
  }
}

// 3. HTTP: static host, 404 host, SPA-fallback host.
function serve(mode) {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (mode === 'static') {
      try {
        const body = readFileSync(path.join(SHADERS, p));
        res.setHeader('content-type', 'text/plain');
        return res.end(body);
      } catch {
        res.statusCode = 404;
        return res.end('nf');
      }
    }
    if (mode === 'notfound') {
      res.statusCode = 404;
      return res.end('nf');
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>app</body></html>'); // spa
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}
for (const mode of ['static', 'notfound', 'spa']) {
  const srv = await serve(mode);
  const base = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const d = await loadShaders(base, { features: 0n });
    if (mode === 'static') {
      d.fillFrag === gen('mantle.frag.glsl')
        ? ok('http static host: generated text fetched')
        : fail('http static host: wrong text');
    } else
      fail(
        `${mode} host: expected a throw, got ${Object.keys(d).length} entries (fillVert starts ${JSON.stringify(String(d.fillVert).slice(0, 20))})`,
      );
  } catch (e) {
    if (mode === 'static') fail('http static host threw: ' + e.message);
    else if (mode === 'spa' && /HTML/.test(e.message) && e.message.includes(base))
      ok('spa host: throws naming HTML and the URL');
    else if (mode === 'notfound' && /404/.test(e.message) && e.message.includes(base))
      ok('404 host: throws naming the status and URL');
    else fail(`${mode} host: unhelpful error: ${e.message.slice(0, 160)}`);
  }
  srv.close();
}

// 4. The createRenderer error names real functions.
{
  const src = readFileSync(path.join(HERE, '../src/renderer/renderer.js'), 'utf8');
  /loadShadersSync/.test(src)
    ? fail('renderer.js still names loadShadersSync')
    : ok('renderer.js does not name loadShadersSync');
  /pass the dict from `await bundleShaders\.fromPackage\(\)`/.test(src)
    ? ok('createRenderer error names bundleShaders.fromPackage()')
    : fail('createRenderer error text does not name bundleShaders.fromPackage()');
}

// A COLR bundle's PaintColrLayers is a PaintMerge, drawn by the feComposite program (filterGraph/colr/paints.js), which core does not
// hold: a dict selected by the bundle's own features left every layered glyph clearing to nothing.
shaderKeysFor({ features: 1n << 25n }).has('feCompositeFrag')
  ? ok('a COLR feature set holds the program its layers draw with')
  : fail('a COLR feature set has no feCompositeFrag');

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('shaderLoadPathsSmoke: PASS');
