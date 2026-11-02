// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// obbGradientRowsSmoke -- objectBoundingBox gradients on rotated or skewed elements are re-placed by minting one gradient
// record per (gradient, carrier matrix) pair (bundleFinalize.js rebindObbGradients). The minting has no row cap: a 2048-row
// guard (a texture height the wrapped gradient table does not need) would leave everything past it with the axis-aligned
// placement and only a warning. CPU proof, node lane: the importer mints a row for every rotated / skewed
// carrier at any count, never warns, and the rows it mints are the same bytes whether the art is one document or a prefix of it.
// The pixels are test/obbGradientRowsRenderSmoke.mjs.
import './_domShim.mjs';
import { xmldom, doc } from './_domShim.mjs';
globalThis.DOMParser = xmldom.DOMParser;
globalThis.XMLSerializer = xmldom.XMLSerializer;
if (!globalThis.document) globalThis.document = doc;
const { importSvg, setDiagnostics } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warns = [];
setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });

const COLS = 60;
const art = (n, how) => {
  let b = '';
  for (let i = 0; i < n; i++) {
    const cx = (i % COLS) * 8 + 4,
      cy = Math.floor(i / COLS) * 8 + 4;
    const t =
      how === 'skew'
        ? `translate(${cx} ${cy}) skewX(20) translate(-3 -3)`
        : how === 'axis'
          ? `translate(${cx - 3} ${cy - 3})`
          : `rotate(${30 + (i % 7) * 11} ${cx} ${cy}) translate(${cx - 3} ${cy - 3})`;
    b += `<rect width="6" height="6" transform="${t}" fill="url(#g)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>${b}</svg>`;
};
const rowsOf = (sec) => (sec.gradients ? sec.gradients.byteLength / 64 : 0);

for (const how of ['rotate', 'skew']) {
  for (const n of [200, 2047, 2048, 2049, 2600, 4200]) {
    warns.length = 0;
    const sec = await importSvg(art(n, how), { preserveViewport: true });
    const rows = rowsOf(sec);
    // each shape has its own carrier (distinct translation), so each owns a minted row plus the shared base row
    ok(rows === n + 1, `${how} ${n} carriers: ${rows} gradient rows (want ${n + 1})`);
    ok(
      !warns.some((w) => /gradient rows|axis-aligned/.test(w)),
      `${how} ${n}: no placement warning`,
    );
  }
}
// a document at most 2048 rows is a byte-identical prefix of the bigger one (minting order does not depend on the count)
{
  const small = rowsOf(await importSvg(art(1500, 'rotate'), { preserveViewport: true }));
  const a = new Uint8Array(
    (await importSvg(art(1500, 'rotate'), { preserveViewport: true })).gradients,
  );
  const b = new Uint8Array(
    (await importSvg(art(3000, 'rotate'), { preserveViewport: true })).gradients,
  );
  let same = small === 1501;
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
  ok(
    same,
    "the first 1501 gradient rows of a 3000-carrier document are the 1500-carrier document's rows, byte for byte",
  );
}
// axis-aligned carriers never mint (positive diagonal): one row at any count
{
  const sec = await importSvg(art(3000, 'axis'), { preserveViewport: true });
  ok(rowsOf(sec) === 1, `3000 axis-aligned carriers share one row (${rowsOf(sec)})`);
}
if (fail) {
  console.error(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log(
  '\nobbGradientRowsSmoke: every rotated/skewed objectBoundingBox carrier gets its own placement row at any count',
);
