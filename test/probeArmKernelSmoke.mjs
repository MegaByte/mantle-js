// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probeArmKernelSmoke — a probe arm is named by what it COMPILES.
//
// THE HAZARD. An "sdf" arm built as `createRenderer(gl, shaders, {})` — no MANTLE_GWN, no
// MANTLE_GWN_SDF, Loop-Blinn left on 'auto' — compiles SLUG (or draws Loop-Blinn), so a timing or
// quality comparison against GWN's winding-only tree route measures a shader the arm never names.
// An `armDiff` control asking whether two such arms differ does not catch it: they DO differ,
// because Slug differs from winding-only exactly as GWN would.
//
// WHY A NODE TEST CAN SEE IT. `coverKernelOfVariantKey` (src/renderer/engineLedger.js) IS the
// fragment shader's own selection chain over a define set, so the kernel an arm would compile is
// decidable from the arm's options alone — no GL, no browser. This resolves every probe arm whose
// NAME claims GWN or SDF through that function and holds it to its name.
//
//   (a) `const rX = createRenderer(gl, shaders, OPTS)` with X naming gwn or sdf: OPTS must resolve
//       to the GWN kernel (or the tree-hard one, for a winding-only arm), and an arm naming SDF
//       must carry MANTLE_GWN_SDF, not bare MANTLE_GWN — which compiles GWN_WINDING_ONLY;
//   (b) such an arm must also PIN Loop-Blinn, because on 'auto' a bundle with meshes is drawn by LB
//       whatever fill kernel the program carries;
//   (c) an `engine === 'gwn'` branch of an options map must name a GWN define;
//   (d) non-vacuity: `{}` resolves to Slug, and the GWN define pair resolves to GWN.
import path from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { ENGINES, coverKernelOfVariantKey } from '../src/renderer/engineLedger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- (d) the resolver says what this test needs it to say ------------------------------------------------------------
ok(
  coverKernelOfVariantKey('', false) === ENGINES.SLUG &&
    coverKernelOfVariantKey('MANTLE_GWN|MANTLE_GWN_SDF', false) === ENGINES.GWN &&
    coverKernelOfVariantKey('MANTLE_HARD|MANTLE_HARD_TREE|MANTLE_GWN', false) === ENGINES.HARD_TREE,
  '(d) the shader selection chain: no defines is Slug, the GWN pair is GWN, tree-hard is hard-tree',
);

// ---- probe sources ---------------------------------------------------------------------------------------------------
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.mjs')) files.push(p);
  }
})(path.join(ROOT, 'probes'));

/// The fill defines an options literal asks for. `aacFill: true` is the renderer's own shorthand for
/// MANTLE_AAC, so it resolves the same way the fill pass resolves it.
function definesOf(opts) {
  const defs = [];
  const m = opts.match(/fillDefines\s*:\s*\[([^\]]*)\]/);
  if (m) for (const q of m[1].match(/'[^']*'|"[^"]*"/g) || []) defs.push(q.slice(1, -1));
  if (/\baacFill\s*:\s*true\b/.test(opts)) defs.push('MANTLE_AAC');
  return defs;
}
/// The options literal that follows `createRenderer(gl, shaders,` at `i`, brace-matched.
function optsAt(src, i) {
  const open = src.indexOf('{', i);
  if (open < 0 || open > i + 40) return null;
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(open, k + 1);
  }
  return null;
}

const ARM = /\b(?:const|let|var)\s+(\w+)\s*=\s*createRenderer\s*\(\s*gl\s*,\s*shaders\s*,/g;
const arms = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  ARM.lastIndex = 0;
  let m;
  while ((m = ARM.exec(src))) {
    const opts = optsAt(src, m.index + m[0].length - 1);
    if (opts == null) continue;
    // The rest of the statement's LINE plus the next one: `r.setLoopBlinnFill('off')` is written
    // there in every probe that pins it.
    const lineEnd = src.indexOf('\n', m.index);
    const tail = src.slice(m.index, src.indexOf('\n', lineEnd + 1) + 1 || undefined);
    arms.push({
      file: path.relative(ROOT, f),
      name: m[1],
      defs: definesOf(opts),
      pinsLb: new RegExp(`${m[1]}\\.setLoopBlinnFill`).test(tail),
    });
  }
}
ok(arms.length >= 20, `${arms.length} named renderer arms across ${files.length} probe files`);

// ---- (a) and (b) -------------------------------------------------------------------------------------------------------
const claims = arms.filter((a) => /gwn|sdf/i.test(a.name));
ok(
  claims.length >= 8,
  `${claims.length} of them name GWN or SDF: ${[...new Set(claims.map((a) => a.file.split('/').pop()))].join(', ')}`,
);
{
  const bad = claims.filter((a) => {
    const k = coverKernelOfVariantKey(a.defs.join('|'), false);
    return k !== ENGINES.GWN && k !== ENGINES.HARD_TREE;
  });
  // ...and which of them are WINDING-only, named here so the distinction stays visible: bare
  // MANTLE_GWN has no candidates and no ramp, so such an arm is a no-AA kernel and can only be
  // compared on ink, never on AA error or on frame time against an antialiasing engine.
  const wind = claims.filter(
    (a) => a.defs.includes('MANTLE_GWN') && !a.defs.includes('MANTLE_GWN_SDF'),
  );
  ok(
    bad.length === 0,
    `(a) every arm naming GWN or SDF compiles a GWN kernel` +
      (bad.length
        ? `: ${bad.map((a) => `${a.file} ${a.name} -> ${coverKernelOfVariantKey(a.defs.join('|'), false)} [${a.defs.join(',') || 'no defines'}]`).join('; ')}`
        : '') +
      ` (winding-only, ink-comparable only: ${wind.map((a) => `${a.file.split('/').pop()} ${a.name}`).join(', ') || 'none'})`,
  );
}
{
  // Bare MANTLE_GWN compiles GWN_WINDING_ONLY (_coverage.glsl 1580) — no candidates, no ramp. An
  // arm whose name says SDF and whose defines say winding-only is the same mislabel one rung in.
  const bad = claims.filter((a) => /sdf/i.test(a.name) && !a.defs.includes('MANTLE_GWN_SDF'));
  ok(
    bad.length === 0,
    `(a) an arm naming SDF carries MANTLE_GWN_SDF, not bare MANTLE_GWN` +
      (bad.length
        ? `: ${bad.map((a) => `${a.file} ${a.name} [${a.defs.join(',') || 'no defines'}]`).join('; ')}`
        : ''),
  );
}
{
  const bad = claims.filter((a) => !a.pinsLb);
  ok(
    bad.length === 0,
    `(b) every such arm pins Loop-Blinn instead of leaving it on 'auto'` +
      (bad.length ? `: ${bad.map((a) => `${a.file} ${a.name}`).join('; ')}` : ''),
  );
}

// ---- (c) -----------------------------------------------------------------------------------------------------------
{
  // An arm selected by an engine NAME rather than by a variable name: `engine === 'gwn' ? OPTS`.
  // The branch is only part of the story (the same test also picks the import options and the
  // proof), so the rule is file-level — a probe that offers a 'gwn' engine has to name a GWN define
  // somewhere in it.
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (/(?:engine|arm|eng)\s*===?\s*['"]gwn['"]/.test(src) && !/MANTLE_GWN/.test(src))
      bad.push(path.relative(ROOT, f));
  }
  ok(
    bad.length === 0,
    `(c) a probe offering a 'gwn' engine names a GWN define` +
      (bad.length ? `: ${[...new Set(bad)].join(', ')}` : ''),
  );
}

console.log(fail ? `probeArmKernelSmoke FAIL (${fail})` : 'probeArmKernelSmoke PASS');
process.exit(fail ? 1 : 0);
