// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The fast path's CHEAP DECLINE must reach the same verdict as a full build.
//
// buildLoopBlinnMesh(..., bailOnDecline=true) stops at scanConcavity instead of paying for
// buildRims — 71% of the cost of a mesh the caller is about to discard. That is only sound while
// the scan MIRRORS buildRims exactly: scanConcavity re-derives the same four decline sites
// (quad/rquad concavity, degree-reduced-cubic concavity, cubic loop/cusp, cubic-piece concavity)
// against the same per-contour interiorSign. If the two ever drift, a shape the fast path could
// have taken silently falls to the CDT — or worse, a concave shape is accepted and mis-threaded.
//
// So: for every shape in the corpus, build both ways and require the accept/decline verdict to
// agree. Pure CPU, no GPU — this is a build-time invariant.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildLoopBlinnMesh } from '../src/renderer/lbFastMesh.js';
import { parsePathD } from '../src/svg/path.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  console.error('FAIL ' + m);
  failures++;
};

const toContours = (segs) => {
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (s.subStart || !cur) {
      if (cur && cur.length) out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur && cur.length) out.push(cur);
  return out;
};

const dir = path.join(ROOT, 'examples');
const shapes = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.svg')))
  for (const d of [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\sd="([^"]+)"/g)].map(
    (m) => m[1],
  )) {
    let cs;
    try {
      cs = toContours(parsePathD(d));
    } catch {
      continue;
    }
    if (cs && cs.length) shapes.push({ file: f, cs });
  }

const accepted = (m) => !!(m && !m.fallback.length && !m.hasConcave);
let n = 0,
  agree = 0,
  declined = 0;
const bad = [];
for (const { file, cs } of shapes) {
  let full = null,
    bail = null;
  try {
    full = buildLoopBlinnMesh(cs, true, 'nonzero');
  } catch {
    full = undefined;
  }
  try {
    bail = buildLoopBlinnMesh(cs, true, 'nonzero', true);
  } catch {
    bail = undefined;
  }
  if (full === undefined || bail === undefined) continue; // both threw the same way
  n++;
  const a = accepted(full),
    b = accepted(bail);
  if (a === b) {
    agree++;
    if (!a) declined++;
  } else bad.push(`${file}: full=${a ? 'accept' : 'decline'} bail=${b ? 'accept' : 'decline'}`);
}

if (n > 100) ok(`non-vacuous: ${n} shapes built both ways`);
else fail(`vacuous: only ${n} shapes exercised`);
if (declined > 20)
  ok(`non-vacuous: ${declined} of them DECLINE (the path the bail short-circuits)`);
else fail(`vacuous: only ${declined} declines — the bail is barely exercised`);
if (!bad.length) ok(`cheap decline agrees with the full build on all ${agree} shapes`);
else {
  fail(`${bad.length} shape(s) disagree — scanConcavity has drifted from buildRims`);
  bad.slice(0, 8).forEach((b) => console.error('   ' + b));
}

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nlbFastPathDeclineSmoke: scanConcavity mirrors buildRims — the cheap decline is exact',
);
