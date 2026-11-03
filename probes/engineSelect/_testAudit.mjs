// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _testAudit.mjs — the test suite as a CONSTRAINT on the engine-selection API.
//
//   node probes/engineSelect/_testAudit.mjs [--list] [--which prepare|noawait|explicit|routing]
//
// A build gate as a default runs into tests that build under 'auto', then pin a mode afterwards,
// and assert a routing number with no prepare or await in between. Those counts decide whether
// the TESTS or the API are wrong, so they should be a thing this repository can recount rather
// than a number in a document. This recounts them, and prints the file lists.
//
// It is a source scan, not a run: it reads what each file CALLS and in what order. That is exactly
// the granularity the question needs — the claim is about call order, not about outcomes — and it
// means the answer costs a second rather than a render lane.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const TEST = path.join(PKG, 'test');
const LIST = process.argv.includes('--list');
const WHICH = (() => {
  const i = process.argv.indexOf('--which');
  return i > 0 ? process.argv[i + 1] : null;
})();

/// A file that has anything to do with the analytic route: it selects an engine, asks what drew, or
/// drives a build. Anything else cannot be moved by a build gate whatever it does.
const TOUCHES_LB =
  /setLoopBlinnFill|setFillEngine|_lbFillMode|lbRouted|_lbRouteCount|prepareBundle|awaitLbReady|_lbMeshes|cpatchFill/;
/// PINNING a mode: the parity idiom is "build under the default, then pin and compare".
const PINS =
  /setLoopBlinnFill\(\s*(['"]on['"]|['"]off['"]|['"]only['"]|true|false)|setFillEngine\(\s*\{[^}]*route:\s*['"](lb|none|only|cpatch)['"]/;
/// EXPLICITLY selecting 'auto' — the only thing that arms the build gate (setLoopBlinnFill's contract).
const SELECTS_AUTO =
  /setLoopBlinnFill\(\s*['"]auto['"]\s*\)|setFillEngine\(\s*\{[^}]*route:\s*['"]auto['"]/;
/// Creating the bundles a gated build would apply to.
const CREATES = /createBundle|importSvg|loadSvg/;
/// Asserting a ROUTING NUMBER — how many draws an engine took, or which engine drew.
const ROUTING =
  /lbRouted|_lbRouteCount|_lbAutoPicked|engines\.(draws|join|includes|length)|debugStats\(\)[^\n]*engines|autoEngine/;
/// Waiting for a build to land, or forcing one.
const AWAITS = /awaitLbReady|prepareBundle|awaitEngine|lbPrepareBlocking/;

const files = readdirSync(TEST)
  .filter((f) => f.endsWith('.mjs'))
  .sort();
const rows = [];
for (const f of files) {
  const src = readFileSync(path.join(TEST, f), 'utf8');
  if (!TOUCHES_LB.test(src)) continue;
  const pinAt = src.search(PINS);
  const autoAt = src.search(SELECTS_AUTO);
  const createAt = src.search(CREATES);
  const routingAt = src.search(ROUTING);
  // "no prepare or await in between": is there an AWAITS call between the pin and the routing
  // assertion that follows it? Source order is the right proxy — these files are linear scripts,
  // and the page script they build is emitted in order too.
  let awaitBetween = false;
  if (pinAt >= 0 && routingAt > pinAt) {
    const between = src.slice(pinAt, routingAt);
    awaitBetween = AWAITS.test(between);
  }
  rows.push({
    file: f,
    pins: pinAt >= 0,
    selectsAuto: autoAt >= 0,
    autoBeforeCreate: autoAt >= 0 && createAt >= 0 && autoAt < createAt,
    routing: routingAt >= 0,
    routingAfterPin: pinAt >= 0 && routingAt > pinAt,
    awaitBetween,
  });
}

const n = (p) => rows.filter(p).length;
const pinners = rows.filter((r) => r.pins);
const noAwait = rows.filter((r) => r.pins && r.routingAfterPin && !r.awaitBetween);
const explicitAuto = rows.filter((r) => r.selectsAuto);
const armed = rows.filter((r) => r.autoBeforeCreate);

console.log(`LB-touching test files: ${rows.length} of ${files.length}`);
console.log(`  pin a mode after building                         ${pinners.length}`);
console.log(
  `  ...and assert a routing number after the pin      ${n((r) => r.pins && r.routingAfterPin)}`,
);
console.log(`  ...with NO prepare/await between pin and assert    ${noAwait.length}`);
console.log(`  select 'auto' EXPLICITLY anywhere                 ${explicitAuto.length}`);
console.log(`  ...BEFORE creating their bundles (gate ARMS)      ${armed.length}`);
console.log('');
console.log(
  "THE GATE FIRES only on a file in the last row: an explicit 'auto' selected before the",
);
console.log(
  "bundles exist. Every other file builds under the DEFAULT 'auto', which does not gate,",
);
console.log('so a later pin still finds every mesh. That is the whole contract.');

if (LIST || WHICH) {
  const show = (title, set) => {
    console.log(`\n${title} (${set.length})`);
    for (const r of set) console.log('  ' + r.file);
  };
  if (!WHICH || WHICH === 'prepare') show('files that pin a mode after building', pinners);
  if (!WHICH || WHICH === 'noawait')
    show('...asserting a routing number with no await between', noAwait);
  if (!WHICH || WHICH === 'explicit') show("files that select 'auto' explicitly", explicitAuto);
  if (!WHICH || WHICH === 'routing')
    show("files that select 'auto' BEFORE creating a bundle (the gate arms)", armed);
}
