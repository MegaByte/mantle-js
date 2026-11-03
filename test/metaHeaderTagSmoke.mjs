// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// metaHeaderTagSmoke -- the meta header carries a magic and a version word (bytes 20..27), and createBundle checks them.
// Without a tag in the 32-byte meta header a foreign or tampered buffer would be caught only by structural validation. So:
//   (a) every builder stamps META_MAGIC at byte 20 and META_VERSION_PLAIN (2) at byte 24, bytes 28..31 stay zero; a bundle with an
//       origin (bundle/layout.js) stamps version 3 and the origin flag 1 at 28..31, and createBundle needs sections.origin then;
//   (b) a header without the tag (those bytes zero) reads as version 1;
//   (c) a wrong magic, a newer version, version 1 spelled with a magic, and a nonzero pad word are rejected by name;
//   (d) createBundle accepts the tagged and the legacy form and rejects the bad ones before reading shape data.
import { META_MAGIC, META_VERSION, META_VERSION_PLAIN } from '../src/bundle/layout.js';
import { checkMetaHeader } from '../src/renderer/sectionsCheck.js';
import { createFakeGl } from './_fakeGl.mjs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const throwsWith = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e.message));
  }
};

const sec = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#48c"/></svg>',
);
const dv = new DataView(sec.meta);
ok(
  dv.getUint32(20, true) === META_MAGIC &&
    dv.getUint32(24, true) === META_VERSION_PLAIN &&
    dv.getUint32(28, true) === 0,
  '(a) importSvg stamps the tag: 0x' +
    dv.getUint32(20, true).toString(16) +
    ' v' +
    dv.getUint32(24, true),
);
ok(
  META_MAGIC === 0x4c544e4d && String.fromCharCode(...new Uint8Array(sec.meta, 20, 4)) === 'MNTL',
  '(a) the magic reads MNTL in the file bytes',
);

const clone = (mut) => {
  const m = sec.meta.slice(0);
  mut(new DataView(m));
  return m;
};
const legacy = clone((d) => {
  d.setUint32(20, 0, true);
  d.setUint32(24, 0, true);
});
ok(
  !throwsWith(() => checkMetaHeader(legacy), /./),
  '(b) an untagged header is version 1 and reads',
);
ok(!throwsWith(() => checkMetaHeader(sec.meta), /./), '(b) the tagged header reads');
ok(
  !throwsWith(() => checkMetaHeader(new ArrayBuffer(0)), /./),
  '(b) an empty meta (a zero-shape bundle) is not a header error',
);

ok(
  throwsWith(
    () => checkMetaHeader(clone((d) => d.setUint32(20, 0x12345678, true))),
    /not a Mantle meta section/,
  ),
  '(c) a wrong magic is rejected by name',
);
ok(
  throwsWith(
    () => checkMetaHeader(clone((d) => d.setUint32(24, META_VERSION + 1, true))),
    /unsupported meta header version/,
  ),
  '(c) a newer version is rejected',
);
ok(
  throwsWith(
    () => checkMetaHeader(clone((d) => d.setUint32(24, 1, true))),
    /unsupported meta header version/,
  ),
  '(c) version 1 spelled with a magic is rejected',
);
ok(
  throwsWith(() => checkMetaHeader(clone((d) => d.setUint32(28, 7, true))), /bytes 28\.\.31/),
  '(c) a nonzero pad word is rejected',
);
ok(
  throwsWith(
    () =>
      checkMetaHeader(
        clone((d) => {
          d.setUint32(24, 5, true);
          d.setUint32(20, 0, true);
        }),
      ),
    /not a Mantle meta section/,
  ),
  '(c) a version without a magic is rejected',
);

// version 3: the bundle has an origin; the header says so and sections.origin carries it
{
  const far = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect x="100000" y="200000" width="8" height="8" fill="#48c"/></svg>',
  );
  const d3 = new DataView(far.meta);
  ok(
    d3.getUint32(24, true) === META_VERSION &&
      d3.getUint32(28, true) === 1 &&
      Array.isArray(far.origin) &&
      far.origin.length === 2,
    '(a) a far bundle stamps version 3, flag 1, and carries sections.origin',
  );
  ok(
    !throwsWith(() => checkMetaHeader(far.meta, far), /./),
    '(b) a version-3 header with its origin reads',
  );
  ok(
    throwsWith(
      () => checkMetaHeader(far.meta, { ...far, origin: undefined }),
      /sections\.origin is missing/,
    ),
    '(c) a version-3 header with no origin is rejected by name',
  );
  ok(
    throwsWith(
      () => checkMetaHeader(far.meta, { ...far, origin: [NaN, 0] }),
      /pair of finite numbers/,
    ),
    '(c) a version-3 header with a non-finite origin is rejected',
  );
  const m2 = far.meta.slice(0);
  new DataView(m2).setUint32(28, 0, true);
  ok(
    throwsWith(() => checkMetaHeader(m2, far), /flag word/),
    '(c) a version-3 header with an empty flag word is rejected',
  );
}

// version 3: bytes 28..31 are a feature-flag word (origin = 1, hidden rows = 2)
{
  const v3 = (flags) =>
    clone((d) => {
      d.setUint32(24, META_VERSION, true);
      d.setUint32(28, flags, true);
    });
  ok(
    !throwsWith(() => checkMetaHeader(v3(2)), /./),
    'version 3 with the hidden-rows flag alone reads (no origin needed)',
  );
  ok(
    throwsWith(() => checkMetaHeader(v3(4)), /flag word/),
    'version 3 with an unknown flag is refused by name',
  );
  ok(
    throwsWith(() => checkMetaHeader(v3(0)), /flag word/),
    'version 3 with an empty flag word is refused',
  );
  ok(
    throwsWith(() => checkMetaHeader(v3(1)), /origin/),
    'version 3 with the origin flag and no sections.origin is refused',
  );
  ok(
    !throwsWith(() => checkMetaHeader(v3(3), { origin: [10, 20] }), /./),
    'version 3 with origin and hidden flags and an origin reads',
  );
}
const F = createFakeGl({ width: 8, height: 8 });
const withMeta = (m) => ({ ...sec, meta: m });
ok(
  throwsWith(
    () => createBundle(F.gl, withMeta(clone((d) => d.setUint32(20, 1, true)))),
    /not a Mantle meta section/,
  ),
  '(d) createBundle rejects a foreign header',
);
let made = null;
try {
  made = createBundle(F.gl, withMeta(legacy));
} catch (e) {
  made = e;
}
ok(
  made && !(made instanceof Error) && made.numShapes === 1,
  '(d) createBundle accepts the legacy header: ' + (made instanceof Error ? made.message : 'ok'),
);
let made2 = null;
try {
  made2 = createBundle(F.gl, sec);
} catch (e) {
  made2 = e;
}
ok(
  made2 && !(made2 instanceof Error) && made2.numShapes === 1,
  '(d) createBundle accepts the tagged header',
);
process.exit(fail ? 1 : 0);
