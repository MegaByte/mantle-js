// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchWorkerFlagSmoke — a flag the conversion pool forwards reaches the conversion it was
// forwarded for.
//
// THE TRAP. cpatch.worker.js imports cpatchConvert (and through it cpatchImplicit and
// cpatchGraph) at the top, and applies the flags a message carries (`_applyFlags`) per message --
// AFTER those modules evaluate their consts. So a switch captured at module scope, such as
// `const CP_TOL_DEFAULT = globalThis.__CP_TOL_ABS || 0.02`, would be frozen at the worker's default:
// a CPatch A/B that set one through the pool would measure the default and say nothing about it.
// So the knobs are read at call time.
//
// HOW IT IS DRIVEN. The worker module runs here as-is: `self` is stubbed, the module is imported
// exactly as a Worker would, and messages are handed to its onmessage. Each arm is compared with a
// direct conversion under the same global, and the flag must move the answer at all (non-vacuity):
//   __CP_TOL_ABS  (cpatchConvert)   a loose validity bar merges patches of a cubic blob
//   __CP_TRI_EPS  (cpatchImplicit)  a bar no quadratic's control triangle clears declines the blob
// and a message WITHOUT flags afterwards must be back at the default (the worker clears them).
//
// A worker that reads the knobs at module scope FAILS: both armed replies equal the default reply.
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

const replies = [];
globalThis.self = { postMessage: (m) => replies.push(m) };
await import('../src/renderer/cpatch.worker.js');
const { convertContour } = await import('../src/renderer/cpatchConvert.js');

const K = 6;
const blob = (bow, kind) => {
  const at = (j) => [
    100 + 40 * Math.cos((2 * Math.PI * j) / K),
    100 + 40 * Math.sin((2 * Math.PI * j) / K),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    out.push(
      kind === 'quad'
        ? { t: 'quad', P: [A, [mx, my], B] }
        : {
            t: 'cubic',
            P: [
              A,
              [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
              [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
              B,
            ],
          },
    );
  }
  return out;
};
const OPTS = { maxCurves: 8 };
/// One job through the worker's own message handler; the patch count it returns (-1 declined).
const viaWorker = (curves, flags) => {
  replies.length = 0;
  self.onmessage({ data: { id: 1, jobs: [{ key: 0, curves }], opts: OPTS, flags } });
  const r = replies[0] && replies[0].out[0];
  return r && r.patches ? r.patches.slim.length : -1;
};
/// The same conversion in this thread, with the global set around it.
const direct = (curves, key, value) => {
  // both are test hooks, read only under __MANTLE_DEBUG__
  if (key) {
    globalThis.__MANTLE_DEBUG__ = true;
    globalThis[key] = value;
  }
  let r = null;
  try {
    r = convertContour(curves, OPTS);
  } finally {
    if (key) {
      delete globalThis[key];
      delete globalThis.__MANTLE_DEBUG__;
    }
  }
  return r && r.patches ? r.patches.length : -1;
};

for (const [key, value, curves, what] of [
  ['__CP_TOL_ABS', 50, blob(0.44), 'cubic blob'],
  ['__CP_TRI_EPS', 0.9, blob(0.3, 'quad'), 'quad blob'],
]) {
  console.log(`${key} = ${value} (${what})`);
  const def = viaWorker(curves, null);
  const armed = viaWorker(curves, { __MANTLE_DEBUG__: true, [key]: value });
  // ...and WITHOUT __MANTLE_DEBUG__ it is a test hook left set on a live page: inert
  const inert = viaWorker(curves, { [key]: value });
  const after = viaWorker(curves, null);
  const want = direct(curves, key, value);
  check(want !== def, `the flag moves a direct conversion at all (${def} -> ${want} patches)`);
  check(
    armed === want,
    `forwarded through the worker it converts as the direct call does (${armed} vs ${want})`,
  );
  check(inert === def, `without __MANTLE_DEBUG__ it is inert (${inert} vs ${def})`);
  check(
    after === def,
    `and the next message without it is back at the default (${after} vs ${def})`,
  );
  check(globalThis[key] === undefined, 'the worker cleared the flag it applied');
}

if (fail) {
  console.log(`FAIL cpatchWorkerFlagSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS cpatchWorkerFlagSmoke');
