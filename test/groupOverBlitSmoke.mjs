// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupOverBlitSmoke — a NORMAL-blend group composites by a fixed-function src-over blit, with no
// backdrop copy; a non-normal one still copies and runs composite.frag.
//
// The copy path (groupBegin copies the group's rect of the canvas into mainCopyTex; a nested group
// copies its parent's accumulator at groupEnd instead) exists only so groupEnd can recompute, in
// composite.frag under a REPLACE, opacity x source over that backdrop. For uBlendMode 0 that is
// premultiplied src-over, which the blend unit does itself: ONE, ONE_MINUS_SRC_ALPHA drawing the
// accumulator with cacheBlit at uTint = vec4(opacity). So a normal group skips the copy, the second
// texture read per pixel and the unpremultiply round trip. Precondition: nothing may write the canvas, or the
// parent's accumulator, between groupBegin and groupEnd.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, which records every copy, clear and
// draw with its target, textures, blend function, viewport and uniforms. Per frame, per route:
//   (A) a normal group, alone or nested in a normal group: NO copy at all this frame, no
//       composite.frag; each group's composite is one cacheBlit of its own accumulator under
//       ONE, ONE_MINUS_SRC_ALPHA with uTint = (op, op, op, op), into its parent's accumulator or
//       the canvas, its uInMap matching its viewport (the group rect) 1:1;
//   (B) a non-normal group still copies: the outermost copies the CANVAS, a nested one its
//       PARENT's accumulator, and composites with composite.frag under ONE, ZERO;
//   (C) mixed nests take each group's own path (a normal group inside a multiply one and the
//       reverse);
//   (D) __MANTLE_GROUP_COPY_COMPOSITE (debug) puts a normal group back on the copy path -- the
//       switch probes/filtperf/groupOverBlitAB.mjs times.
// Plus a float32 CPU twin of the arithmetic: composite.frag's normal mode against the blend unit's
// src + dst * (1 - src.a) over a sweep of premultiplied 8-bit inputs and opacities, rounded to
// 8 bits -- the "at most 1 LSB" the render smoke allows. Pixels are the render lane's:
// test/groupOverBlitRenderSmoke.mjs renders both paths in one page and against Chrome.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');

const N = 120;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const RED = '<rect x="10" y="10" width="60" height="80" fill="#f00"/>';
const BLUE = '<rect x="40" y="40" width="60" height="60" fill="#00f"/>';
const GREEN = '<rect x="80" y="80" width="30" height="30" fill="#0a0"/>';
const GROUND = '<rect x="0" y="0" width="120" height="120" fill="#ffc864" fill-opacity="0.5"/>';
// Each case lists its groups in the order their groupEnds run (innermost first): the blend mode
// ('normal' composites by the blit), the opacity, and the depth (0 = outermost).
const CASES = [
  {
    name: 'an opacity group',
    body: `${GROUND}<g opacity="0.5">${RED}${BLUE}</g>`,
    groups: [{ normal: true, op: 0.5, depth: 0 }],
  },
  {
    name: 'an isolated group at opacity 1',
    body: `${GROUND}<g style="isolation:isolate">${RED}${BLUE}</g>`,
    groups: [{ normal: true, op: 1, depth: 0 }],
  },
  {
    name: 'nested opacity groups',
    body: `${GROUND}<g opacity="0.5">${RED}<g opacity="0.25">${BLUE}</g>${GREEN}</g>`,
    groups: [
      { normal: true, op: 0.25, depth: 1 },
      { normal: true, op: 0.5, depth: 0 },
    ],
  },
  {
    name: 'a multiply group',
    body: `${GROUND}<g style="mix-blend-mode:multiply">${RED}${BLUE}</g>`,
    groups: [{ normal: false, mode: 1, depth: 0 }],
  },
  {
    name: 'a multiply group in an opacity group',
    body: `${GROUND}<g opacity="0.5">${RED}<g style="mix-blend-mode:multiply">${BLUE}</g>${GREEN}</g>`,
    groups: [
      { normal: false, mode: 1, depth: 1 },
      { normal: true, op: 0.5, depth: 0 },
    ],
  },
  {
    name: 'an opacity group in a screen group',
    body: `${GROUND}<g style="mix-blend-mode:screen">${RED}<g opacity="0.5">${BLUE}</g>${GREEN}</g>`,
    groups: [
      { normal: true, op: 0.5, depth: 1 },
      { normal: false, mode: 2, depth: 0 },
    ],
  },
];
const FRAMES = 4;

async function run(body, route, copyFlag) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* the route check reports it */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  const stats = [];
  const prev = [globalThis.__MANTLE_DEBUG__, globalThis.__MANTLE_GROUP_COPY_COMPOSITE];
  if (copyFlag) {
    globalThis.__MANTLE_DEBUG__ = true;
    globalThis.__MANTLE_GROUP_COPY_COMPOSITE = true;
  }
  try {
    for (let i = 0; i < FRAMES; i++) {
      F.setFrame(i);
      R.beginFrame([0, 0, 0, 0]);
      R.drawBundle(b);
      R.endFrame();
      stats.push(Object.assign({}, R.debugStats));
    }
  } finally {
    [globalThis.__MANTLE_DEBUG__, globalThis.__MANTLE_GROUP_COPY_COMPOSITE] = prev;
  }
  return { F, stats, R };
}

const near = (a, b) => Math.abs(a - b) < 1e-6;

/// The group composites in one frame, in order: a composite.frag draw under ONE, ZERO, or a
/// cacheBlit whose unit-0 texture is an accumulator (a target this frame cleared with its depth
/// buffer -- groupBegin's clear -- that no other composite reads as a filter result).
function checkFrame(F, frame, c, copyFlag) {
  const ev = F.log.filter((e) => e.frame === frame);
  const has = (e, k) => F.progKeys(e.prog).has(k);
  const accFbos = new Set(
    ev.filter((e) => e.op === 'clear' && e.mask & 0x0100 && e.fbo).map((e) => e.fbo),
  );
  const comps = ev.filter(
    (e) =>
      e.op === 'draw' &&
      (has(e, 'compositeFrag') || (has(e, 'cacheBlitFrag') && accFbos.has(F.fboOf(e.units[0])))),
  );
  const copies = ev.filter((e) => e.op === 'copy');
  const bad = [];
  if (comps.length !== c.groups.length) {
    return [`${comps.length} group composite(s) this frame (want ${c.groups.length})`];
  }
  const accOf = (e) => F.fboOf(e.units[0]);
  const outerAcc = accOf(comps[comps.length - 1]);
  c.groups.forEach((g, k) => {
    const e = comps[k];
    const normal = g.normal && !copyFlag;
    const where = g.depth === 0 ? 'the canvas' : "its parent's accumulator";
    const wantFbo = g.depth === 0 ? null : outerAcc;
    const tag = `group ${k} (${g.normal ? 'normal, opacity ' + g.op : 'mode ' + g.mode}, depth ${g.depth})`;
    if (e.fbo !== wantFbo)
      bad.push(
        `${tag}: composited into ${e.fbo === null ? 'the canvas' : 'an offscreen target'}, want ${where}`,
      );
    if (!accOf(e) || (g.depth > 0 && accOf(e) === outerAcc))
      bad.push(`${tag}: does not read an accumulator of its own`);
    if (normal) {
      const t = e.uni.uTint || [];
      const m = e.uni.uInMap || [],
        vp = e.vp;
      if (!has(e, 'cacheBlitFrag'))
        bad.push(`${tag}: drew with ${[...F.progKeys(e.prog)].join('+')}, want the cacheBlit`);
      if (!e.blend || e.blend.join() !== 'ONE,ONE_MINUS_SRC_ALPHA')
        bad.push(`${tag}: blend ${e.blend}, want ONE,ONE_MINUS_SRC_ALPHA`);
      if (!(t.length === 4 && t.every((v) => near(v, g.op))))
        bad.push(`${tag}: uTint ${JSON.stringify(t)}, want ${g.op} x4`);
      if (!(
        m.length === 4 &&
        near(m[0], vp[2] / N) &&
        near(m[1], vp[3] / N) &&
        near(m[2], vp[0] / N) &&
        near(m[3], vp[1] / N)
      )) {
        bad.push(
          `${tag}: uInMap ${JSON.stringify(m)} does not read the accumulator 1:1 over viewport ${JSON.stringify(vp)}`,
        );
      }
      if (e.units[1] !== undefined && has(e, 'compositeFrag')) bad.push(`${tag}: reads a backdrop`);
    } else {
      if (!has(e, 'compositeFrag'))
        bad.push(`${tag}: drew with ${[...F.progKeys(e.prog)].join('+')}, want composite.frag`);
      if (!e.blend || e.blend.join() !== 'ONE,ZERO')
        bad.push(`${tag}: blend ${e.blend}, want ONE,ZERO`);
      // Its backdrop: the last copy into the texture it reads on unit 1, of the canvas for the
      // outermost group and of the parent's accumulator for a nested one.
      const bd = e.units[1];
      const i = ev.indexOf(e);
      const cp = copies.filter((x) => x.dst === bd && ev.indexOf(x) < i).pop();
      if (!cp) bad.push(`${tag}: no copy into its backdrop`);
      else if (cp.src !== wantFbo)
        bad.push(
          `${tag}: its backdrop is a copy of ${cp.src === null ? 'the canvas' : 'an offscreen target'}, want ${where}`,
        );
      const wantMode = copyFlag && g.normal ? 0 : g.mode;
      if ((e.uni.uBlendMode | 0) !== wantMode)
        bad.push(`${tag}: uBlendMode ${e.uni.uBlendMode}, want ${wantMode}`);
    }
  });
  // Every copy this frame must belong to a group that composites over it.
  const wantCopies = c.groups.filter((g) => !g.normal || copyFlag).length;
  if (copies.length !== wantCopies)
    bad.push(`${copies.length} copies this frame (want ${wantCopies}: one per non-normal group)`);
  return bad;
}

for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  for (const route of ['none', 'lb']) {
    for (const copyFlag of c.groups.some((g) => g.normal) ? [false, true] : [false]) {
      const { F, stats } = await run(c.body, route, copyFlag);
      const first = stats[0],
        last = stats[FRAMES - 1];
      const d = (k) => (last[k] | 0) - (first[k] | 0);
      const arm = `route ${route}${copyFlag ? ', __MANTLE_GROUP_COPY_COMPOSITE' : ''}`;
      if (route === 'lb') {
        ok(
          d('unifiedFillDraws') > 0 &&
            d('unifiedGroupBrackets') >= 2 * c.groups.length * (FRAMES - 1),
          `${arm} is the unified route (gate ${last.unifiedFillGate}, brackets +${d('unifiedGroupBrackets')})`,
        );
      } else {
        ok(
          d('unifiedFillDraws') === 0,
          `${arm} is the classic route (unified draws +${d('unifiedFillDraws')})`,
        );
      }
      const bad = [];
      for (let i = 1; i < FRAMES; i++)
        for (const m of checkFrame(F, i, c, copyFlag)) bad.push(`frame ${i}: ${m}`);
      ok(
        !bad.length,
        `${arm}: ${copyFlag ? 'every group takes the copy path' : 'each group takes its own path'}` +
          (bad.length ? ' -- ' + bad.slice(0, 4).join(' | ') : ''),
      );
    }
  }
}

// ---- the arithmetic, in float32 ------------------------------------------------------------------
// composite.frag at uBlendMode 0 (then the REPLACE writes it) against the blend unit's src-over of
// the tinted texel. Both results round to 8 bits the way a UNORM8 target does.
{
  const f = Math.fround;
  const u8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const tex = (v) => f(v / 255);
  const unpre = (c, a) => (a > 0 ? c.map((x) => f(x / a)) : c);
  const composite = (s, d, o) => {
    const sp = s.map((x) => f(tex(x) * f(Math.max(o, 0)))),
      dp = d.map(tex);
    const as = sp[3],
      ad = dp[3];
    const src = unpre(sp.slice(0, 3), as),
      dst = unpre(dp.slice(0, 3), ad);
    const out = [0, 1, 2].map((i) => {
      const outRgb = f(f(f(1 - ad) * src[i]) + f(ad * src[i]));
      return f(f(as * outRgb) + f(f(ad * f(1 - as)) * dst[i]));
    });
    out.push(f(f(as + ad) - f(as * ad)));
    return out.map(u8);
  };
  const blit = (s, d, o) => {
    const sp = s.map((x) => f(tex(x) * f(o)));
    return [0, 1, 2, 3].map((i) => u8(f(sp[i] + f(tex(d[i]) * f(1 - sp[3])))));
  };
  let n = 0,
    diff1 = 0,
    worst = 0,
    at = null;
  for (const o of [1, 0.75, 0.5, 0.25, 0.1]) {
    for (let sa = 0; sa <= 255; sa += 15)
      for (let sr = 0; sr <= sa; sr += Math.max(1, sa >> 2)) {
        for (let da = 0; da <= 255; da += 15)
          for (let dr = 0; dr <= da; dr += Math.max(1, da >> 2)) {
            const s = [sr, sa - sr, sr >> 1, sa],
              dd = [dr, da - dr, dr >> 1, da];
            const a = composite(s, dd, o),
              b = blit(s, dd, o);
            const m = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
            n++;
            if (m === 1) diff1++;
            if (m > worst) {
              worst = m;
              at = { s, d: dd, o, a, b };
            }
          }
      }
  }
  ok(
    worst <= 1,
    `float32 twin: composite.frag normal vs the src-over blit over ${n} premultiplied inputs: ` +
      `max ${worst} LSB, ${diff1} at 1 LSB` +
      (worst > 1 ? ` -- worst ${JSON.stringify(at)}` : ''),
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
