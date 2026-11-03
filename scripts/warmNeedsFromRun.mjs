// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmNeedsFromRun -- turn a recording run into a game's needs manifest (mantle-needs v1, src/renderer/warmPolicy.js), to ship next to the game's config.
//
//   node scripts/warmNeedsFromRun.mjs <input.json> [--game <id>] [--out needs.json]
//
// <input.json> is one of:
//   * a warm manifest: `renderer.exportWarmManifest()` of a session created with `{ recordWarmManifest: true }` (version 1..3). Its variants, pipelines, programs,
//     draw states (-> reach tags) and viewport classes carry over.
//   * a shader-usage row file (census-<game>.json, rows[0]; read by needsFromCensusRow): the fill variant keys the game DREW.
//   * a needs manifest: re-emitted normalized (unknown fields dropped, keys sorted).
// Several inputs may be merged: pass more than one path; the union is written.
import fs from 'node:fs';
import {
  needsFromWarmManifest,
  needsFromCensusRow,
  parseNeeds,
  NEEDS_FORMAT,
  NEEDS_VERSION,
} from '../src/renderer/warmPolicy.js';

const args = process.argv.slice(2);
const files = [];
let game = null,
  out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--game') game = args[++i];
  else if (args[i] === '--out') out = args[++i];
  else files.push(args[i]);
}
if (!files.length) {
  console.error(
    'usage: node scripts/warmNeedsFromRun.mjs <input.json>... [--game id] [--out needs.json]',
  );
  process.exit(2);
}
const merged = {
  format: NEEDS_FORMAT,
  version: NEEDS_VERSION,
  game,
  variants: new Set(),
  programs: new Map(),
  reach: new Map(),
  scales: new Map(),
};
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  let n;
  if (
    j &&
    Array.isArray(j.rows) &&
    j.rows.some((r) => r && r.ds && r.ds.needMiss && r.ds.needMiss.keys)
  ) {
    // a harness run exported with debugStats.needMiss: the variants and programs the session requested that nobody had warmed or declared are NEEDS (added to the recorded ones)
    const v = new Set(),
      pr = new Map();
    for (const r of j.rows)
      for (const k of (r.ds && r.ds.needMiss && r.ds.needMiss.keys) || []) {
        const i = k.indexOf(':'),
          kind = k.slice(0, i),
          key = k.slice(i + 1);
        if (kind === 'fill') v.add(key);
        else pr.set(kind, { t: kind, a: [] });
      }
    const base = j.rows.find((r) => r.progFacts)
      ? needsFromCensusRow(
          j.rows.find((r) => r.progFacts),
          { game: j.game },
        )
      : { game: j.game, variants: [], programs: [], reach: [], scales: [] };
    n = {
      game: base.game,
      variants: [...new Set([...base.variants, ...v])],
      programs: [...pr.values()],
      reach: [],
      scales: [],
    };
  } else if (j && j.format === NEEDS_FORMAT) {
    const p = parseNeeds(j);
    n = {
      game: p.game,
      variants: [...p.variants],
      programs: p.programs,
      reach: p.reach,
      scales: p.scales,
    };
  } else if (j && Array.isArray(j.rows) && j.rows[0])
    n = needsFromCensusRow(j.rows[0], { game: j.game });
  else n = needsFromWarmManifest(j, { game });
  if (!merged.game && n.game) merged.game = n.game;
  for (const k of n.variants) merged.variants.add(k);
  for (const p of n.programs) merged.programs.set(p.t + JSON.stringify(p.a), p);
  for (const r of n.reach) {
    const t = merged.reach.get(r.bundle) || new Set();
    for (const x of r.tags) t.add(x);
    merged.reach.set(r.bundle, t);
  }
  for (const s of n.scales) merged.scales.set(s.c, s);
}
const res = {
  format: NEEDS_FORMAT,
  version: NEEDS_VERSION,
  game: merged.game,
  variants: [...merged.variants].sort(),
  programs: [...merged.programs.values()],
  reach: [...merged.reach].map(([bundle, t]) => ({ bundle, tags: [...t].sort() })),
  scales: [...merged.scales.values()].sort((a, b) => a.c - b.c),
};
const text = JSON.stringify(res, null, 1) + '\n';
if (out) {
  fs.writeFileSync(out, text);
  console.log(
    `${out}: ${res.variants.length} variants, ${res.programs.length} programs, ${res.reach.length} reach entries, ${res.scales.length} scales`,
  );
} else process.stdout.write(text);
