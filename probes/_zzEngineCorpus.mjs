// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzEngineCorpus — speed AND quality for every engine, over a real corpus, at several sizes.
//
// One asset cannot rank these engines. Their costs follow different axes -- Slug's follows FILL
// AREA, Loop-Blinn's the per-draw fixed cost and so the shape count, CPatch's the blocks a fragment
// fetches, AAC's the band walk -- and tiger happens to sit at one point in that space (304 shapes,
// 2787 curves, cubics only, no arcs, no quads). Assets that are quad-only, arc-heavy, line-only, or
// carry forty curves per shape rank them differently, and that is the thing worth knowing.
//
// PROTOCOL. One page per (asset, size), with every engine run TWICE in sequence and the better of
// its two reads taken. A page's first arm is not a frame time -- see the note in _zzEnginePaint --
// and the penalty is per engine, not per page: on tiger at 512 the pairs read slug 5.50/4.00, aac
// 2.40/2.60, lb 1.90/2.10, cpatch 5.40/2.90, against per-engine clean runs of 4.10 / 2.60 / 2.20 /
// 2.50. So the warm read of a pair is within 0.2-0.4 ms of giving each engine its own page, at a
// quarter of the cost, and the reference is rasterized once per page instead of four times.
//
//   CORPUS=file   one SVG path per line (default /tmp/corpus.txt)
//   SIZES=256,512,1024
//   FRAMES=16
//   OUT=file      TSV written here as well as to stdout
//   TREES=a=dir,b=dir  run every cell against each SOURCE TREE (a js.kontek.mantle directory) in turn, e.g.
//                 old=../old-checkout/js.kontek.mantle,head=. -- trees alternate inside each cell and swap order every
//                 other cell, because a GPU comparison across separate runs drifts 30-40% and only an interleaved one
//                 counts. The paint probe and its node-side reference always run from this tree; only the PAGE's modules
//                 are served from the other one (PAGE_ROOT), so both sides share one instrument and one reference. Copying
//                 the probe into an old tree does not work: the reference imports modules that tree never had.
//   ENGINES=...   comma-separated arms, '|' between PAGES. An entry is a bare arm ('lb') or label=spec
//                 ('cpatch-seam0=cpatch:__CP_FAN_SEAM=0'). Default: slug,aac,lb,cpatch on one page. More
//                 than four engines belong on separate pages -- eight arms in one page already failed on
//                 some assets (see NO ARMS below).
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const list = readFileSync(process.env.CORPUS || '/tmp/corpus.txt', 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
const SIZES = (process.env.SIZES || '256,512,1024').split(',').map(Number);
const FRAMES = process.env.FRAMES || '16';
const GROUPS = (process.env.ENGINES || 'slug,aac,lb,cpatch').split('|').map((g) =>
  g
    .split(',')
    .filter(Boolean)
    .map((e) => {
      const i = e.indexOf('=');
      return i > 0 && !e.slice(0, i).includes(':')
        ? { label: e.slice(0, i), spec: e.slice(i + 1) }
        : { label: e, spec: e };
    }),
);
const ENGINES = GROUPS.flat();
// The probe starts each arm's lines with its SPEC. Longest first, so 'cpatch' cannot claim 'cpatch:__CP_FAN_SEAM=0'.
const ALTS = [...ENGINES]
  .sort((a, b) => b.spec.length - a.spec.length)
  .map((e) => e.spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const LABEL = Object.fromEntries(ENGINES.map((e) => [e.spec, e.label]));
const ARM_RE = new RegExp(`^(${ALTS})\\s+([0-9.]+)\\s+ms`);
const DEAD_RE = new RegExp(`^(${ALTS}):? DID NOT DRAW`);

const rows = [];
// THE PATH, NOT THE BASENAME. Two different assets in one corpus can share a name -- this corpus
// carries two ruled-out.svg from different directories -- and an analysis keyed on the name then
// collapses them into one cell, silently dropping twelve measurements and pairing one asset's
// profile with another's timings. Found by diffing this file against a copy rebuilt from the log.
const HEAD_ROOT = path.resolve(HERE, '..');
// PAGE_TIMEOUT: one probe page's limit, seconds. A healthy page takes a few minutes, so a hang costs at most this.
const PAGE_TIMEOUT_MS = 1000 * +(process.env.PAGE_TIMEOUT || 300);
const TREES = (process.env.TREES || '')
  .split(',')
  .filter(Boolean)
  .map((t) => {
    const i = t.indexOf('=');
    return { label: t.slice(0, i), root: path.resolve(t.slice(i + 1)) };
  });
if (!TREES.length) TREES.push({ label: 'head', root: HEAD_ROOT });
// SKIP=tree:arm+arm,...  arms a tree cannot run (e.g. a release whose page hangs on them), reported as SKIPPED rather than
// spending PAGE_TIMEOUT on every cell. A group left with no arms is not spawned.
const SKIP = new Set(
  (process.env.SKIP || '')
    .split(',')
    .filter(Boolean)
    .flatMap((t) => {
      const i = t.indexOf(':');
      return t
        .slice(i + 1)
        .split('+')
        .map((a) => `${t.slice(0, i)}:${a}`);
    }),
);
const skipped = (tree, e) =>
  SKIP.has(`${tree.label}:${e.label}`) || SKIP.has(`${tree.label}:${e.spec}`);
for (const t of TREES) {
  if (!existsSync(path.join(t.root, 'src', 'index.js'))) {
    console.error(`!! TREE ${t.label}: no src/index.js under ${t.root}`);
    process.exit(1);
  }
}
const hdr = [
  'path',
  'asset',
  'px',
  'engine',
  'ms',
  'wrongSolid',
  'outside',
  'aaOver3',
  'aaMean',
  'jaggy',
  'partialPct',
  'tree',
  'refLacks',
];
console.log(hdr.join('\t'));
let assetIdx = 0;
for (const f of list) {
  assetIdx++;
  const name = path.basename(f);
  for (let sizeIdx = 0; sizeIdx < SIZES.length; sizeIdx++) {
    const N = SIZES[sizeIdx];
    // TREES ALTERNATE WITHIN THE CELL and swap order every other cell, so neither side always runs on a warmer GPU.
    // By ASSET + SIZE, not by a running cell count: with two sizes a running count gave every 256px cell the same order and every
    // 1024px cell the other, confounding size with which tree ran first.
    const order = (assetIdx + sizeIdx) % 2 === 0 ? TREES : [...TREES].reverse();
    for (const tree of order) {
      let out = '';
      // ONE PAGE PER GROUP, every arm in it run twice; the outputs are concatenated and parsed as one.
      out = '';
      for (const grp0 of GROUPS) {
        const grp = grp0.filter((e) => !skipped(tree, e));
        if (!grp.length) continue;
        const ARMS = grp.flatMap((e) => [e.spec, e.spec]).join(',');
        try {
          out +=
            execFileSync('node', [path.join(HERE, '_zzEnginePaint.mjs')], {
              cwd: HEAD_ROOT,
              maxBuffer: 1 << 28,
              timeout: PAGE_TIMEOUT_MS,
              // WAITCULL: measure AFTER the asynchronous occlusion cull lands. Without it a cell's quality depends on whether
              // its engine's build was slow enough for the cull worker to answer first, so an unsound cull reads as
              // wrong pixels charged to the slowest engine alone while every faster engine looks clean.
              env: {
                ...process.env,
                SVG: f,
                N: String(N),
                GPU: '1',
                FRAMES,
                ARMS,
                WAITCULL: process.env.WAITCULL ?? '1',
                PAGE_ROOT: tree.root === HEAD_ROOT ? '' : tree.root,
              },
            }).toString() + '\n';
        } catch (e) {
          // A HUNG PAGE IS NAMED AS ONE. execFileSync kills the child at the timeout and reports ETIMEDOUT; folding that into a
          // generic spawn failure would hide which cells hang.
          const timedOut = e.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(e.message || ''));
          out +=
            (e.stdout ? e.stdout.toString() : '') +
            (timedOut
              ? `\nSPAWNFAIL TIMEOUT after ${PAGE_TIMEOUT_MS / 1000}s`
              : '\nSPAWNFAIL ' + (e.message || '')) +
            '\n';
        }
      }
      // A COMBINATION THAT PRODUCED NO ARM AT ALL IS SHOUTED ABOUT, not left as a quiet MISSING in
      // the table. Two of the first sweep's 39 combinations came back empty -- one whole asset and
      // one size of another -- and both render perfectly well when run alone, so the failure is in
      // running eight arms in one page, not in the asset. Four cells went unreported in the first
      // write-up because MISSING rows look like data.
      if (!out.split('\n').some((l) => ARM_RE.test(l))) {
        const why = (out.match(/SPAWNFAIL.*/) || out.match(/PAGEERROR.*/) || [''])[0].slice(0, 160);
        console.error(
          `!! NO ARMS for ${name} @${N}px [${tree.label}] -- ${why || 'no arm line in ' + out.length + ' bytes of output'}`,
        );
      }
      // Parse the per-arm blocks. An arm that did not draw with its own engine prints DID NOT DRAW
      // and withholds its numbers; that is a result, not a gap, so it is carried as such.
      const cur = {};
      const refLacks = (out.match(/REFERENCE LACKS (.*?) --/) || [])[1] || '';
      let arm = null;
      for (const line of out.split('\n')) {
        let m = line.match(ARM_RE);
        if (m) {
          arm = LABEL[m[1]];
          const ms = +m[2];
          (cur[arm] ||= []).push({ ms });
          continue;
        }
        m = line.match(DEAD_RE);
        if (m) {
          arm = LABEL[m[1]];
          (cur[arm] ||= []).push({ ms: NaN, dead: true });
          continue;
        }
        if (!arm || !cur[arm] || !cur[arm].length) continue;
        const rec = cur[arm][cur[arm].length - 1];
        if ((m = line.match(/WRONG SOLID (\d+) px/))) rec.wrong = +m[1];
        else if ((m = line.match(/PAINTED OUTSIDE (\d+) px/))) rec.outside = +m[1];
        else if ((m = line.match(/AA\s+over0\.3 (\d+).*mean ([0-9.]+)/))) {
          rec.aa3 = +m[1];
          rec.aaMean = +m[2];
        } else if ((m = line.match(/JAGGY (\d+) edge/))) rec.jaggy = +m[1];
        else if ((m = line.match(/AA PIXELS\s+(\d+) of the reference's (\d+)/)))
          rec.pct = Math.round((100 * +m[1]) / Math.max(1, +m[2]));
      }
      for (const eng of ENGINES) {
        const e = eng.label;
        if (skipped(tree, eng)) {
          const r = [f, name, N, e, 'SKIPPED', '', '', '', '', '', '', tree.label, refLacks];
          rows.push(r);
          console.log(r.join('\t'));
          continue;
        }
        const got = cur[e] || [];
        const live = got.filter((g) => !g.dead && Number.isFinite(g.ms));
        // THE BETTER OF THE PAIR. The cold read is the first one for most engines and the second for
        // none of them consistently (AAC pays no warm-up at all), so min is the estimator that does
        // not need to know which is which.
        const best = live.length ? live.reduce((a, b) => (b.ms < a.ms ? b : a)) : null;
        const q = got.find((g) => g.wrong !== undefined) || best || {};
        const r = [
          f,
          name,
          N,
          e,
          best ? best.ms.toFixed(2) : got.length ? 'NODRAW' : 'MISSING',
          q.wrong ?? '',
          q.outside ?? '',
          q.aa3 ?? '',
          q.aaMean ?? '',
          q.jaggy ?? '',
          q.pct ?? '',
          tree.label,
          refLacks,
        ];
        rows.push(r);
        console.log(r.join('\t'));
      }
    }
  }
}
if (process.env.OUT)
  writeFileSync(
    process.env.OUT,
    [hdr.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n') + '\n',
  );
