// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// useBudgetSmoke -- a <use> expansion budget. A doubling chain of nested <use> (each level two uses of the next) is 2^levels
// instances: 16 levels take seconds, about 30 never finish. importSvg counts the <use> instances it expands and refuses the document,
// with a named error, past `maxUseInstances` (default 100000, Infinity disables it). Normal art is unaffected: the largest <use> count in
// the repo corpus and a 7,907-SVG real-world corpus is 104.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const warn = console.warn;
console.warn = () => {};
const wrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">${body}</svg>`;
/// Level 0 is a rect; level i is a <g> holding two uses of level i-1. The root draws one use of the top level.
const chain = (levels) => {
  let defs = '<rect id="l0" width="1" height="1"/>';
  for (let i = 1; i <= levels; i++)
    defs += `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}" x="1"/></g>`;
  return `<defs>${defs}</defs><use href="#l${levels}"/>`;
};
// (The depths are named constants so the smoke-asset generator, which derives example files from literal calls, does not write a 2^40-instance document.)
const DEPTH = { huge: 40, big: 17, six: 6, two: 2 };
const instances = (levels) => 2 ** (levels + 1) - 1; // 1 + 2 + 4 + ... + 2^levels
const run = async (svg, opts) => {
  if (!svg.startsWith('<svg')) svg = wrap(svg); // (a chain is a body: see DEPTH)
  const t0 = Date.now();
  try {
    const b = await importSvg(svg, opts);
    return { b, ms: Date.now() - t0 };
  } catch (e) {
    return { e, ms: Date.now() - t0 };
  }
};

console.log('a deep doubling chain is refused at the configured budget');
{
  const r = await run(chain(DEPTH.huge), { maxUseInstances: 127 });
  check(
    !!r.e && /maxUseInstances/.test(r.e.message) && /<use>/.test(r.e.message),
    `40 levels throws a named error (${r.e ? r.e.message.slice(0, 80) : 'it imported'})`,
  );
}
console.log('the budget is exact and configurable');
{
  const n = instances(DEPTH.six); // 127
  let r = await run(chain(DEPTH.six), { maxUseInstances: n });
  check(!r.e, `${n} instances import with maxUseInstances ${n}`);
  r = await run(chain(DEPTH.six), { maxUseInstances: n - 1 });
  check(
    !!r.e && /maxUseInstances/.test(r.e.message),
    `${n} instances throw with maxUseInstances ${n - 1}`,
  );
  r = await run(chain(DEPTH.six), { maxUseInstances: Infinity });
  check(
    !r.e && r.b.numShapes === 64,
    `Infinity disables the budget (64 rects, got ${r.b?.numShapes})`,
  );
  r = await run(chain(DEPTH.six), {});
  check(!r.e, 'the default budget (100000) admits a 127-instance document');
  r = await run(chain(DEPTH.big), {});
  check(!!r.e, 'the default budget refuses 2^18 instances');
  for (const bad of [-1, NaN, 'many']) {
    r = await run(chain(DEPTH.two), { maxUseInstances: bad });
    check(
      r.e instanceof RangeError && /maxUseInstances/.test(r.e.message),
      `maxUseInstances ${JSON.stringify(bad)} is a RangeError`,
    );
  }
  r = await run(chain(DEPTH.two), { maxUseInstances: 0 });
  check(!!r.e, 'maxUseInstances 0 refuses any <use>');
}
console.log('documents the budget does not concern');
{
  let r = await run(wrap('<rect width="9" height="9"/><g><circle r="3"/></g>'), {
    maxUseInstances: 0,
  });
  check(!r.e && r.b.numShapes === 2, 'no <use>: no budget applies');
  r = await run(
    wrap(
      '<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/><rect width="4" height="4"/>',
    ),
    {},
  );
  check(
    !r.e && r.b.numShapes === 1,
    'a <use> cycle is still cut by the cycle guard, not the budget',
  );
  r = await run(
    wrap('<defs><rect id="r" width="4" height="4"/></defs>' + '<use href="#r"/>'.repeat(500)),
    {},
  );
  check(!r.e && r.b.numShapes === 500, '500 sibling uses import');
}
console.warn = warn;
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('useBudgetSmoke: all passed');
