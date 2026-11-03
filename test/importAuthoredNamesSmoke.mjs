// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importAuthoredNamesSmoke: names an author writes are data, whatever they spell, and a sprite allow-list keeps what a kept sprite needs.
//
// (a) An id, a url() reference, a color name or a keyword that spells an Object.prototype member (constructor, toString, valueOf,
//     __proto__) must not reach the prototype through a plain-object lookup (the import would throw or store NaN). As an id it must work
//     like any other; as a reference to nothing it is a reference to nothing.
// (b) importSvg({ sprites }): a sprite the list leaves out holding a compositing group does not throw, and a kept sprite's clip or mask
//     keeps its content (without it the sprite draws nothing).
// (c) A filter or mask group over a path past the engine's argument limit does not report "the document nests too deeply".
// (d) A filter reference that names no filter opens no group.
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const L = await import('../src/bundle/layout.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${body}</svg>`;
const rows = (b) => {
  const m = new Float32Array(b.meta, 32),
    s = b.metaFloatsPerShape || 48,
    out = [];
  for (let r = 0; r < b.numShapes; r++) out.push(m.subarray(r * s, (r + 1) * s));
  return out;
};
const fill = (a) => [a[L.META_FILL_R], a[L.META_FILL_G], a[L.META_FILL_B], a[L.META_FILL_A]];
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const attempt = async (label, body, opts, check) => {
  try {
    const b = await importSvg(doc(body), opts);
    const r = rows(b);
    ok(r.every((a) => a.every((v) => !Number.isNaN(v))) && check(r, b), label);
  } catch (e) {
    ok(false, `${label}: threw ${e.message}`);
  }
};

console.log('(a) references to nothing');
const LIME = [0, 1, 0, 1],
  BLACK = [0, 0, 0, 1];
const R = 'width="9" height="9"';
for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
  await attempt(
    `fill url(#${name}) lime paints the fallback`,
    `<rect ${R} fill="url(#${name}) lime"/>`,
    {},
    (r) => same(fill(r[0]), LIME),
  );
  await attempt(
    `stroke url(#${name}) lime paints the fallback`,
    `<rect ${R} fill="none" stroke="url(#${name}) lime"/>`,
    {},
    (r) => r.some((a) => a[L.META_STROKE_G] === 1 && a[L.META_STROKE_W] > 0),
  );
  await attempt(
    `clip-path url(#${name}) clips nothing`,
    `<rect ${R} clip-path="url(#${name})"/>`,
    {},
    (r) => r[0][L.META_CLIP_ID] === 0,
  );
  await attempt(
    `mask url(#${name}) masks nothing`,
    `<rect ${R} mask="url(#${name})"/>`,
    {},
    (r) => r[0][L.META_MASK_ID] === 0,
  );
  await attempt(
    `filter url(#${name}) filters nothing`,
    `<rect ${R} filter="url(#${name})"/>`,
    {},
    (r) => r[0][L.META_FILTER_ID] === 0,
  );
  await attempt(
    `marker url(#${name}) places nothing`,
    `<path d="M0 0L9 9" stroke="red" fill="none" marker-end="url(#${name})"/>`,
    {},
    (r) => r.length === 1,
  );
  await attempt(
    `use #${name} draws nothing`,
    `<use href="#${name}"/><rect ${R}/>`,
    {},
    (r) => r.length === 1,
  );
  await attempt(
    `gradient href #${name} ends the chain`,
    `<linearGradient id="g" href="#${name}"><stop stop-color="red"/></linearGradient><rect ${R} fill="url(#g)"/>`,
    {},
    (r) => r[0][L.META_FILL_GRAD] === 1,
  );
  await attempt(
    `pattern href #${name} ends the chain`,
    `<pattern id="p" href="#${name}" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5"/></pattern><rect ${R} fill="url(#p)"/>`,
    {},
    (r) => r.length === 2,
  );
  await attempt(
    `fill="${name}" is not a color`,
    `<g fill="lime"><rect ${R} fill="${name}"/></g>`,
    {},
    (r) => same(fill(r[0]), LIME),
  );
  await attempt(
    `transform ${name}() is invalid`,
    `<rect ${R} transform="${name}(5)"/>`,
    {},
    (r) => r[0][L.META_BBOX_XMAX] === 9,
  );
  await attempt(
    `font-size ${name} is ignored`,
    `<rect width="1em" height="9" style="font-size:${name}"/>`,
    {},
    (r) => r[0][L.META_BBOX_XMAX] === 16,
  );
  await attempt(
    `mix-blend-mode ${name} is normal`,
    `<rect ${R} style="mix-blend-mode:${name}"/>`,
    {},
    (r) => r[0][L.META_BLEND_MODE] === 0,
  );
  await attempt(
    `group mix-blend-mode ${name} is normal`,
    `<g style="mix-blend-mode:${name}"><rect ${R}/></g>`,
    {},
    (r) => r.every((a) => a[L.META_BLEND_MODE] === 0),
  );
  await attempt(
    `in="${name}" reads the previous result`,
    `<filter id="f"><feGaussianBlur in="${name}" stdDeviation="1"/><feOffset in="${name}" dx="1"/></filter><rect ${R} filter="url(#f)"/>`,
    {},
    (r) => r[0][L.META_FILTER_ID] > 0,
  );
}
console.log('(a) the same names as ids');
for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
  await attempt(
    `<use> of an element with id ${name}`,
    `<defs><rect id="${name}" ${R}/></defs><use href="#${name}"/>`,
    {},
    (r) => r.length === 1 && same(fill(r[0]), BLACK),
  );
  await attempt(
    `a gradient with id ${name}`,
    `<linearGradient id="${name}"><stop stop-color="red"/></linearGradient><rect ${R} fill="url(#${name})"/>`,
    {},
    (r) => r[0][L.META_FILL_GRAD] === 1,
  );
  await attempt(
    `a pattern with id ${name}`,
    `<pattern id="${name}" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="red"/></pattern><rect ${R} fill="url(#${name})"/>`,
    {},
    (r) => r.length === 2 && r[0][L.META_FLAGS_SHAPE] === 256,
  );
  await attempt(
    `a clipPath with id ${name}`,
    `<clipPath id="${name}"><rect width="5" height="5"/></clipPath><rect ${R} clip-path="url(#${name})"/>`,
    {},
    (r) => r[0][L.META_CLIP_ID] === 2 && r[1][L.META_BBOX_XMAX] === 5,
  );
  await attempt(
    `a mask with id ${name}`,
    `<mask id="${name}"><rect width="5" height="5" fill="white"/></mask><rect ${R} mask="url(#${name})"/>`,
    {},
    (r) => r[0][L.META_MASK_ID] === 2 && r[1][L.META_BBOX_XMAX] === 5,
  );
  await attempt(
    `a filter with id ${name}`,
    `<filter id="${name}"><feGaussianBlur stdDeviation="1"/></filter><rect ${R} filter="url(#${name})"/>`,
    {},
    (r) => r[0][L.META_FILTER_ID] === 1,
  );
  await attempt(
    `a marker with id ${name}`,
    `<marker id="${name}" markerWidth="4" markerHeight="4"><rect width="4" height="4" fill="lime"/></marker><path d="M0 0L9 9" stroke="red" fill="none" marker-end="url(#${name})"/>`,
    {},
    (r) => r.length === 2,
  );
}

console.log('(b) the sprite allow-list');
const sheet = (rest) => `<g id="a"><rect ${R}/></g><g id="b">${rest}</g>`;
await attempt(
  'a left-out sprite holding a <use> with opacity',
  `<defs><rect id="r" ${R}/></defs>` + sheet('<use href="#r" opacity="0.5"/>'),
  { sprites: ['a'] },
  (r) => r.length === 1,
);
await attempt(
  'a left-out sprite holding a masked group',
  `<mask id="m"><rect width="50" height="50" fill="#888"/></mask>` +
    sheet(`<g mask="url(#m)"><rect ${R}/><rect ${R}/></g>`),
  { sprites: ['a'] },
  (r) => r.length === 1,
);
await attempt(
  'a left-out sprite holding an opacity group',
  sheet(`<g opacity="0.5"><rect ${R}/></g>`),
  { sprites: ['a'] },
  (r) => r.length === 1,
);
await attempt(
  'a left-out sprite claims no clip content',
  `<clipPath id="c"><rect width="5" height="5"/></clipPath>` +
    sheet(`<rect ${R} clip-path="url(#c)"/>`),
  { sprites: ['a'] },
  (r) => r.length === 1,
);
await attempt(
  'a kept sprite keeps its clip content',
  `<clipPath id="c"><rect width="5" height="5"/></clipPath><g id="a"><rect ${R} clip-path="url(#c)"/></g><g id="b"><rect ${R}/></g>`,
  { sprites: ['a'] },
  (r) =>
    r.length === 2 &&
    r[0][L.META_CLIP_ID] === 2 &&
    r[1][L.META_BBOX_XMAX] === 5 &&
    r[1][L.META_FILL_A] === 1,
);
await attempt(
  'a kept sprite keeps its mask content',
  `<mask id="m"><rect width="5" height="5" fill="white"/></mask><g id="a"><rect ${R} mask="url(#m)"/></g><g id="b"><rect ${R}/></g>`,
  { sprites: ['a'] },
  (r) =>
    r.length === 2 &&
    r[0][L.META_MASK_ID] === 2 &&
    r[1][L.META_BBOX_XMAX] === 5 &&
    r[1][L.META_FILL_A] === 1,
);
await attempt(
  'a kept sprite keeps a two-level clip',
  `<clipPath id="c"><g id="x"><rect width="5" height="5"/></g><rect x="6" width="5" height="5"/></clipPath><g id="a"><rect ${R} clip-path="url(#c)"/></g>`,
  { sprites: ['a'] },
  (r) => r.length === 2 && r[1][L.META_BBOX_XMAX] === 11,
);

console.log('(c) a group over a very long path');
{
  const parts = ['M0 0'];
  for (let i = 0; i < 130000; i++) parts.push(`L${i % 100} ${i % 97}`);
  const longPath = parts.join('');
  await attempt(
    'a filter group over 130000 segments',
    `<filter id="f"><feGaussianBlur stdDeviation="1"/></filter><g filter="url(#f)"><path d="${longPath}"/></g>`,
    {},
    (r) => r[0][L.META_FILTER_ID] === 1,
  );
}

console.log('(d) a reference to no filter');
await attempt(
  '<g filter="url(#missing)"> opens no group',
  `<g filter="url(#missing)"><rect ${R}/></g>`,
  {},
  (r) => r.length === 1 && r[0][L.META_FLAGS_SHAPE] === 0,
);

console.log(
  fail ? `\nimportAuthoredNamesSmoke: ${fail} failed` : '\nimportAuthoredNamesSmoke: passed',
);
process.exit(fail ? 1 : 0);
