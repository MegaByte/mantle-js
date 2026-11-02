// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Development-only Float32 model of the CPatch coefficient blend shader.
// This cannot qualify GPU pixels, GPU arithmetic or renderer performance.
export function installCpatchBlendShaderModel(fake) {
  const f32 = Math.fround;
  fake.hook.onBlend = ({
    fragmentSource: fs,
    uniforms: u,
    target: out,
    viewport: vp,
    colorMask: cm,
    units,
  }) => {
    const pA = units.get(u.uPA),
      pB = units.get(u.uPB),
      pC = units.get(u.uPC);
    const BT = +(fs.match(/int blk = idx \/ (\d+)/) || [0, 7])[1];
    const CT = +(fs.match(/int ci = blk \* (\d+)/) || [0, 0])[1];
    const cRows = /row == 5/.test(fs) ? [2, 3, 5, 6] : [2, 3];
    const fetch = (t, x, y) => {
      const i = (y * t.w + x) * 4;
      return [t.data[i], t.data[i + 1], t.data[i + 2], t.data[i + 3]];
    };
    const uu = Math.min(1, Math.max(0, u.uU));
    for (let y = vp[1]; y < vp[1] + vp[3]; y++)
      for (let x = vp[0]; x < vp[0] + vp[2]; x++) {
        const py = y - u.uY0,
          idx = py * u.uNB + x,
          blk = Math.floor(idx / BT),
          row = idx - blk * BT;
        const a = fetch(pA, x, py),
          b = fetch(pB, x, py);
        let w = a[3];
        if (cRows.includes(row)) {
          const ci = CT ? blk * CT + (row > 3 ? 1 : 0) : blk;
          const c = fetch(pC, ci % u.uNC, Math.floor(ci / u.uNC));
          w = f32(
            w +
              f32(
                uu *
                  (row === 2 || row === 5
                    ? f32(c[0] + f32(uu * c[1]))
                    : f32(c[2] + f32(uu * c[3]))),
              ),
          );
        }
        const o = [
          f32(a[0] + f32(uu * b[0])),
          f32(a[1] + f32(uu * b[1])),
          f32(a[2] + f32(uu * f32(b[2] + f32(uu * b[3])))),
          w,
        ];
        if (!cm[3]) o[3] = out.data[(y * out.w + x) * 4 + 3];
        out.data.set(o, (y * out.w + x) * 4);
      }
  };
}
