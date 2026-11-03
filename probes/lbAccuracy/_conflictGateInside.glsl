// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

    if (!wgA && !wgB && fOwn12 >= 0.0) {
      vec2 uA12 = vec2(-nA12.y, nA12.x) * (mod(codeA, 2.0) > 0.5 ? 1.0 : -1.0);
      vec2 uB12 = vec2(-nB12.y, nB12.x) * (mod(codeB, 2.0) > 0.5 ? 1.0 : -1.0);
      if (!cnA && gA12 > 0.0 && dot(sA12, nA12) > 0.0 && fA12 < 0.0 && dot(rA, uA12) >= 0.0) discard;
      if (!cnB && gB12 > 0.0 && dot(sB12, nB12) > 0.0 && fB12 < 0.0 && dot(rB, uB12) >= 0.0) discard;
    }
