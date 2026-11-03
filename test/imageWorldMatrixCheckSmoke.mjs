// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// imageWorldMatrixCheckSmoke: drawImage and drawImageInstanced hold a world matrix to the rule drawBundle holds it to.
// uniformMatrix3fv refuses a six-element CSS matrix with GL error 1281 and leaves the previous draw's matrix in the program, so the image would draw at
// another image's place; on the instanced path the missing cells read as NaN and the instance vanishes. Both entries throw, naming the argument.
// CPU, on a stand-in GL.
const { mkRenderer } = await import('./_exportHarness.mjs');
const warn = console.warn;
console.warn = () => {};
let fails = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('PASS', name);
  else {
    fails++;
    console.log('FAIL', name, detail ?? '');
  }
};
const { F, R } = await mkRenderer(100, 100);
const img = R.createImage({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });
const threw = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};
R.beginFrame([0, 0, 0, 0]);
for (const [name, m] of [
  ['six elements', [1, 0, 0, 1, 0, 0]],
  ['a NaN', [1, 0, 0, 0, 1, 0, NaN, 0, 1]],
  ['an Infinity', new Float32Array([1, 0, 0, 0, 1, 0, Infinity, 0, 1])],
  ['a string', 'matrix(1,0,0,1,0,0)'],
]) {
  const draws = F.log.length;
  const a = threw(() => R.drawImage(img, { worldMatrix: m }));
  check(`drawImage: ${name} throws`, a && /drawImage: worldMatrix/.test(a), a);
  const b = threw(() => R.drawImageInstanced(img, [{}, { worldMatrix: m }]));
  check(
    `drawImageInstanced: ${name} throws`,
    b && /drawImageInstanced: instances\[1\]\.worldMatrix/.test(b),
    b,
  );
  check(`${name}: nothing was drawn`, !F.log.slice(draws).some((e) => e.op === 'draw'));
}
const I = [1, 0, 0, 0, 1, 0, 5, 6, 1];
check('a nine-element array draws', R.drawImage(img, { worldMatrix: I }) === true);
check('a Float32Array draws', R.drawImage(img, { worldMatrix: new Float32Array(I) }) === true);
check('null draws', R.drawImage(img, { worldMatrix: null }) === true);
check('no options draw', R.drawImage(img) === true);
check('instances draw', R.drawImageInstanced(img, [{ worldMatrix: I }, null, {}]) === 3);
R.endFrame();
console.warn = warn;
if (fails) {
  console.log(`imageWorldMatrixCheckSmoke: ${fails} FAILED`);
  process.exit(1);
}
console.log('imageWorldMatrixCheckSmoke PASS');
process.exit(0);
