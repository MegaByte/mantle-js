// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// porterDuff.js — a Porter-Duff mode as the weights the composite shaders take.
//

const K = [
  [0, 0, 0, 0], //  0 clear      Fa = 0       Fb = 0
  [1, 0, 0, 0], //  1 src        Fa = 1       Fb = 0
  [0, 0, 1, 0], //  2 dst        Fa = 0       Fb = 1
  [1, 0, 1, -1], //  3 src over   Fa = 1       Fb = 1 - as
  [1, -1, 1, 0], //  4 dst over   Fa = 1 - ad  Fb = 1
  [0, 1, 0, 0], //  5 src in     Fa = ad      Fb = 0
  [0, 0, 0, 1], //  6 dst in     Fa = 0       Fb = as
  [1, -1, 0, 0], //  7 src out    Fa = 1 - ad  Fb = 0
  [0, 0, 1, -1], //  8 dst out    Fa = 0       Fb = 1 - as
  [0, 1, 1, -1], //  9 src atop   Fa = ad      Fb = 1 - as
  [1, -1, 0, 1], // 10 dst atop   Fa = 1 - ad  Fb = as
  [1, -1, 1, -1], // 11 xor        Fa = 1 - ad  Fb = 1 - as
  [1, 0, 1, 0], // 12 plus       Fa = 1       Fb = 1   (clamped)
];

/// The (k0, k1, k2, k3) weights of a Porter-Duff mode 0..12; any other mode is Plus, as the shader's
/// chain made it.
export function porterDuffCoefficients(mode) {
  const m = mode | 0;
  return K[m >= 0 && m <= 12 ? m : 12];
}

/// feComposite's operator (0 over, 1 in, 2 out, 3 atop, 4 xor) as a Porter-Duff mode: 3 + 2 op.
export const feCompositeMode = (op) => 3 + 2 * (op | 0);
