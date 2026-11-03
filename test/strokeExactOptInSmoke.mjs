// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeExactOptInSmoke -- the exact stroke edge records are OPT-IN (renderer option strokeExactEdges, define MANTLE_STROKE_EXACT).
//
// WHAT IT PINS
//   (a) the default program has no exact-record code: with the define absent, a small #ifdef evaluator over the SHIPPED generated text of
//       mantle.frag, aacPoints.vert, splitStroke.frag and maskBake.frag leaves no strokeExactCov / sePx / seSector / seTri, and no seAnd,
//       seOr, seDisc or seJoinRecord body (their record writes are gone: the helpers stay as empty shells);
//   (b) with the define the same text DOES carry them (so (a) is not an evaluator that deletes everything);
//   (c) the renderer wiring: createRenderer() hands NO MANTLE_STROKE_EXACT to any stroke program; createRenderer({ strokeExactEdges: true })
//       hands it to every program whose source mentions it, and removing that one define line yields the default program's text, byte for byte
//       -- so an opted-in program is today's exact-AA program, untouched.
// Runs against test/_fakeGl.mjs: no GPU.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(ROOT, 'src/shaders/generated');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? 'ok' : 'FAIL'}: ${m}`);
  if (!c) fail++;
};

// ---- (a)/(b): a #if/#ifdef evaluator for the macros that matter here (everything else is kept) --------------------------------------
function expand(src, defs) {
  const out = [];
  const stack = []; // each: { on, taken, parentOn }
  const live = () => stack.every((s) => s.on);
  const ev = (e) => {
    const j = e
      .replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (defs.has(n) ? 'true' : 'false'))
      .replace(/defined\s+(\w+)/g, (_, n) => (defs.has(n) ? 'true' : 'false'));
    if (/[A-Za-z_]/.test(j.replace(/\btrue\b|\bfalse\b/g, ''))) return null; // an expression over other macros: not ours, keep both sides
    try {
      return !!eval(j);
    } catch {
      return null;
    }
  };
  for (const line of src.split('\n')) {
    const t = line.trim();
    let m;
    if ((m = /^#\s*ifdef\s+(\w+)/.exec(t))) {
      const on = defs.has(m[1]);
      stack.push({ on, taken: on, keep: false });
      continue;
    }
    if ((m = /^#\s*ifndef\s+(\w+)/.exec(t))) {
      const on = !defs.has(m[1]);
      stack.push({ on, taken: on, keep: false });
      continue;
    }
    if ((m = /^#\s*if\s+(.*)$/.exec(t))) {
      const r = ev(m[1]);
      stack.push(
        r === null ? { on: true, taken: true, keep: true } : { on: r, taken: r, keep: false },
      );
      continue;
    }
    if (/^#\s*else\b/.test(t)) {
      const s = stack[stack.length - 1];
      if (!s.keep) {
        s.on = !s.taken;
        s.taken = true;
      }
      continue;
    }
    if ((m = /^#\s*elif\s+(.*)$/.exec(t))) {
      const s = stack[stack.length - 1];
      if (!s.keep) {
        const r = !s.taken && ev(m[1]);
        s.on = !!r;
        s.taken = s.taken || !!r;
      }
      continue;
    }
    if (/^#\s*endif\b/.test(t)) {
      stack.pop();
      continue;
    }
    if (live()) out.push(line);
  }
  return out.join('\n');
}
const FILES = [
  'mantle.frag.glsl',
  'aacPoints.vert.glsl',
  'splitStroke.frag.glsl',
  'maskBake.frag.glsl',
];
const RECORD_BODY = [
  /strokeExactCov\s*\(/,
  /\bsePx\s*\(/,
  /\bseSector\s*\(/,
  /\bseTri\w*\s*\(/,
  /P\s*=\s*vec4\(n,\s*e,\s*1\.0\)/,
  /Q\s*=\s*vec4\(P\.xyz,\s*0\.0\)/,
  /P\s*=\s*vec4\(q\s*\/\s*r,\s*r\s*-\s*halfW,\s*4\.0\)/,
];
for (const f of FILES) {
  const src = fs.readFileSync(path.join(GEN, f), 'utf8');
  const base = new Set(['MANTLE_POINTS_STROKE']);
  const off = expand(src, base),
    on = expand(src, new Set([...base, 'MANTLE_STROKE_EXACT']));
  const hits = (t) => RECORD_BODY.filter((re) => re.test(t)).map((re) => String(re));
  ok(
    hits(off).length === 0,
    `${f}: the default program carries no exact-record code${hits(off).length ? ' (found ' + hits(off).join(', ') + ')' : ''}`,
  );
  if (/strokeExactCov/.test(src))
    ok(hits(on).length > 0, `${f}: the opt-in program carries it (${hits(on).length} markers)`);
  ok(
    on.length > off.length,
    `${f}: the opt-in program is longer than the default (${on.length - off.length} chars)`,
  );
}

// ---- (c): the renderer's wiring -----------------------------------------------------------------------------------------------------
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const REAL = {
  fillFrag: 'mantle.frag.glsl',
  splitStrokeFrag: 'splitStroke.frag.glsl',
  aacPointsVert: 'aacPoints.vert.glsl',
};
const tagged = taggedShaderSources();
const shaders = new Proxy(
  {},
  {
    get: (_t, k) =>
      typeof k === 'string' && REAL[k]
        ? '// @@' + k + '\n' + fs.readFileSync(path.join(GEN, REAL[k]), 'utf8')
        : tagged[k],
    has: () => true,
  },
);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 8 C 40 8 56 24 56 56" fill="none" stroke="#000" stroke-width="6"/></svg>';
const sections = await importSvg(svg);
async function sourcesFor(opts) {
  const F = createFakeGl({ width: 128, height: 128 });
  const seen = [];
  const gl = new Proxy(F.gl, {
    get: (t, k) =>
      k === 'shaderSource'
        ? (sh, src) => {
            seen.push(String(src));
            return t.shaderSource(sh, src);
          }
        : t[k],
  });
  const r = createRenderer(gl, shaders, Object.assign({ psoWarmIdle: () => true }, opts));
  r.setViewport(128, 128);
  const b = createBundle(gl, sections);
  r.prepareBundle(b);
  for (let i = 0; i < 6; i++) {
    r.beginFrame([1, 1, 1, 1]);
    r.drawBundle(b, {});
    r.endFrame();
  }
  return seen;
}
const dflt = await sourcesFor({}),
  optIn = await sourcesFor({ strokeExactEdges: true });
const mentions = (s) =>
  s.indexOf('MANTLE_STROKE_EXACT') >= 0 &&
  s.indexOf('// @@') >= 0 &&
  /strokeExactCov|seAnd/.test(s);
const dStroke = dflt.filter(mentions),
  oStroke = optIn.filter(mentions);
ok(
  dStroke.length > 0,
  `the default renderer compiled ${dStroke.length} stroke-bearing program sources`,
);
ok(
  dStroke.every((s) => !/^#define MANTLE_STROKE_EXACT$/m.test(s)),
  'no default program is handed MANTLE_STROKE_EXACT',
);
ok(
  oStroke.length > 0 && oStroke.every((s) => /^#define MANTLE_STROKE_EXACT$/m.test(s)),
  `every opted-in stroke program is handed MANTLE_STROKE_EXACT (${oStroke.length} programs)`,
);
const strip = (s) => s.replace(/^#define MANTLE_STROKE_EXACT\n/m, '');
const dSet = new Set(dStroke),
  oStripped = oStroke.map(strip);
ok(
  oStripped.every((s) => dSet.has(s)),
  'removing that one define line from each opted-in program gives a default program byte for byte',
);
if (fail) {
  console.error(`strokeExactOptInSmoke: ${fail} failure(s)`);
  process.exit(1);
}
console.log(
  'strokeExactOptInSmoke: the default stroke program has no exact-record code; the opt-in program is the unchanged exact one',
);
