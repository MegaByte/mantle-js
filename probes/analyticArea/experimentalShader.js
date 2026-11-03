// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Probe controls for measured shader variants. Prepared static monotone AAC
// (MANTLE_AREA_MONOTONE) was measured and is not injected. Shipping arms keep
// the raw AAC integrators, with no extra monotone variant.
export function addMonotoneVariant(shaders) {
  for (const fn of ['aacExactI2', 'aacCurveContrib']) {
    if (!Object.values(shaders).some((src) => src.includes('float ' + fn + '(')))
      throw new Error('AAC functions not found');
  }
  // Paired control for the raw AAC control-polygon shortcut. This leaves
  // the position/footprint repairs active and restores the default root loops.
  for (const key of Object.keys(shaders))
    for (const fn of ['aacQuadAxisMono', 'aacCubicAxisMono']) {
      const src = shaders[key],
        start = src.indexOf('bool ' + fn + '(');
      if (start < 0) continue;
      const open = src.indexOf('{', start);
      let depth = 1,
        end = open + 1;
      for (; depth && end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') depth--;
      }
      if (depth) throw Error('AAC control function not found ' + fn);
      shaders[key] =
        src.slice(0, open + 1) +
        '\n#ifdef MANTLE_AAC_NO_CONTROL_MONO\n  return false;\n#else\n' +
        src.slice(open + 1, end - 1) +
        '\n#endif\n' +
        src.slice(end - 1);
    }
  // Same prepared-geometry idea, independently applied to LB's cubic chain
  // area routine. The browser validates the actual packed control points.
  const begin = '    vec2 ex = cub ? cbExtrema(3.0 * cx.x, 2.0 * cx.y, cx.z)';
  const end = '      if (!(tb > ta)) continue;';
  let lbCount = 0;
  for (const key of Object.keys(shaders)) {
    const src = shaders[key],
      i = src.indexOf(begin);
    if (i < 0) continue;
    const j = src.indexOf(end, i);
    if (j < 0) throw new Error('LB extrema anchor not found');
    const fast = `    float ta = 0.0;
    vec2 Pa = A;
    for (int k = 0; k < 1; k++) {
      float tb = 1.0;
`;
    shaders[key] =
      src.slice(0, i) +
      '#ifdef MANTLE_LB_PREPARED_MONOTONE\n' +
      fast +
      '#else\n' +
      src.slice(i, j) +
      '#endif\n' +
      src.slice(j);
    lbCount++;
  }
  if (!lbCount) throw new Error('LB cubic chain not found');
  // Probe a six-component affine inverse instead of the projective matrix.
  // The production selector must retain the matrix for projective world maps.
  for (const key of Object.keys(shaders)) {
    let src = shaders[key];
    for (const q of ['in', 'out'])
      src = src.replace(
        'flat ' + q + ' mat3 vCpClipToLocal;',
        '#ifdef MANTLE_CP_AFFINE_COORD\nflat ' +
          q +
          ' vec4 vCpLinear;\nflat ' +
          q +
          ' vec2 vCpZero;\n#else\nflat ' +
          q +
          ' mat3 vCpClipToLocal;\n#endif',
      );
    src = src.replace(
      '  vCpClipToLocal = mat3(0.0);',
      '#ifdef MANTLE_CP_AFFINE_COORD\n  vCpLinear=vec4(0.0);vCpZero=vec2(0.0);\n#else\n  vCpClipToLocal = mat3(0.0);\n#endif',
    );
    src = src.replace(
      '    if (determinant(H) != 0.0) vCpClipToLocal = inverse(H);',
      '#ifdef MANTLE_CP_AFFINE_COORD\n    mat2 A=mat2(H[0].xy,H[1].xy);\n    if(H[0].z==0.0 && H[1].z==0.0 && H[2].z!=0.0 && determinant(A)!=0.0){\n      mat2 I=inverse(A);vCpLinear=vec4(I[0]*H[2].z,I[1]*H[2].z);vCpZero=-I*H[2].xy;\n    }\n#else\n    if (determinant(H) != 0.0) vCpClipToLocal = inverse(H);\n#endif',
    );
    const body =
      '    if (dot(vCpClipToLocal[2], vCpClipToLocal[2]) > 0.0) {\n      vec2 ndc = 2.0 * (gl_FragCoord.xy + uFragOrigin) / uViewportSize - 1.0;\n      vec3 q = vCpClipToLocal * vec3(ndc, 1.0);\n      cpPoint = q.xy / q.z;\n    }';
    src = src.replace(
      body,
      '#ifdef MANTLE_CP_AFFINE_COORD\n    if(any(notEqual(vCpLinear,vec4(0.0)))){\n      vec2 ndc=2.0*(gl_FragCoord.xy+uFragOrigin)/uViewportSize-1.0;\n      cpPoint=vCpZero+vCpLinear.xy*ndc.x+vCpLinear.zw*ndc.y;\n    }\n#else\n' +
        body +
        '\n#endif',
    );
    shaders[key] = src;
  }
  // Original release sign for an A/B control of the production CPatch fix.
  const foot =
    '        if (dot(aTangent, aTangent) > 0.0)\n          f = dot(p - afoot, vec2(-aTangent.y, aTangent.x)) * (hornRight ? -1.0 : 1.0);';
  for (const key of Object.keys(shaders))
    if (shaders[key].includes(foot))
      shaders[key] = shaders[key].replace(
        foot,
        '#if !defined(MANTLE_CPATCH_BASELINE_FOOT) && !defined(MANTLE_CPATCH_KEEP_FOOT_SIGN)\n' +
          foot +
          '\n#endif',
      );
  const seam = '    if (kind < 0.5 && (sq0 || sq1) && f < 0.0 && compTag < 0.5) {';
  for (const key of Object.keys(shaders))
    if (shaders[key].includes(seam))
      shaders[key] = shaders[key].replace(
        seam,
        '#ifdef MANTLE_CPATCH_BASELINE_FOOT\n    if (false) {\n#else\n' + seam + '\n#endif',
      );
  // Same arithmetic and final rejection, but stop once a minimum cannot recover.
  for (const key of Object.keys(shaders))
    shaders[key] = shaders[key].replace(
      '      // DISCARDING AS SOON AS A CONSTRAINT REJECTS',
      '#ifdef MANTLE_CP_EARLY_REJECT\n      if (cutHard == 0.0 || cov < 0.004) discard;\n#endif\n      // DISCARDING AS SOON AS A CONSTRAINT REJECTS',
    );
  // Release coordinate interpolation, for matched A/B controls only.
  for (const key of Object.keys(shaders)) {
    const src = shaders[key],
      start = src.indexOf('float cpatchCoverage() {');
    if (start < 0) continue;
    const end = src.indexOf('    int first = int(cCen.x + 0.5)', start);
    if (end < 0) throw Error('CPatch grid boundary not found');
    shaders[key] =
      src.slice(0, end) +
      '#ifdef MANTLE_CPATCH_GRID_COORD_ONLY\n    cpPoint = vEm;\n#endif\n' +
      src.slice(end);
  }
  for (const key of Object.keys(shaders))
    shaders[key] = shaders[key].replace(
      /(precision highp[^\n]*\n)/,
      '$1#if defined(MANTLE_CPATCH_BASELINE_FOOT) || defined(MANTLE_CPATCH_INTERPOLATED_COORD)\n#undef MANTLE_CPATCH_PIXEL_COORD\n#endif\n',
    );
  // Matched control for the production affine-footprint repair.
  for (const key of Object.keys(shaders))
    shaders[key] = shaders[key].replace(
      '  if (any(notEqual(vCoverDerivatives, vec4(0.0)))) {',
      '#ifndef MANTLE_COVER_BASELINE_DERIVATIVES\n  if (any(notEqual(vCoverDerivatives, vec4(0.0)))) {\n#else\n  if (false) {\n#endif',
    );
  // Probe-only shared pixel position for affine cover geometry. Reuse the
  // production signed footprint, with one flat origin instead of interpolation.
  const sourceHasCoverPosition = Object.values(shaders).some((src) =>
    src.includes('flat out vec2 vCoverZero;'),
  );
  if (!sourceHasCoverPosition)
    for (const key of Object.keys(shaders)) {
      shaders[key] = shaders[key].replace(
        'flat out vec4 vCoverDerivatives;',
        'flat out vec4 vCoverDerivatives;\n#ifdef MANTLE_COVER_EXACT_POSITION\nflat out vec2 vCoverZero;\n#endif',
      );
      shaders[key] = shaders[key].replace(
        '  vCoverDerivatives = vec4(0.0);',
        '  vCoverDerivatives = vec4(0.0);\n#ifdef MANTLE_COVER_EXACT_POSITION\n  vCoverZero=vec2(0.0);\n#endif',
      );
      shaders[key] = shaders[key].replace(
        '      mat2 I = inverse(A);',
        '      mat2 I = inverse(A);\n#ifdef MANTLE_COVER_EXACT_POSITION\n      vCoverZero=I*(-H[2].xy-H[2].z*vec2(1.0));\n#endif',
      );
      shaders[key] = shaders[key].replace(
        'flat in vec4 vCoverDerivatives;',
        'flat in vec4 vCoverDerivatives;\n#ifdef MANTLE_COVER_EXACT_POSITION\nflat in vec2 vCoverZero;\n#endif',
      );
      shaders[key] = shaders[key].replace(
        '  vec2 ePx = fwidth(emCoord);',
        '#ifdef MANTLE_COVER_EXACT_POSITION\n  if(any(notEqual(vCoverDerivatives,vec4(0.0))))\n    emCoord=vCoverZero+vCoverDerivatives.xy*(gl_FragCoord.x+uFragOrigin.x)+vCoverDerivatives.zw*(gl_FragCoord.y+uFragOrigin.y);\n#endif\n  vec2 ePx = fwidth(emCoord);',
      );
    }
  // Rejected affine square-root cancellation, retained only as a probe.
  for (const key of Object.keys(shaders))
    shaders[key] = shaders[key].replace(
      '  float d = s2 * (st + sqrt(uv)) / denom;',
      '#ifdef MANTLE_COVER_AFFINE_REACH_FAST\n  if(uCoverAaReach==1 && t==0.0) return normal*(s2*1.41421356*max(abs(u),abs(v))/denom);\n#endif\n  float d = s2 * (st + sqrt(uv)) / denom;',
    );
  // Explicit interpolation counterfactual after promoting shared coordinates.
  if (sourceHasCoverPosition)
    for (const key of Object.keys(shaders))
      shaders[key] = shaders[key].replace(
        '  if (any(notEqual(vCoverDerivatives, vec4(0.0))))\n    emCoord = vCoverZero',
        '#if !defined(MANTLE_COVER_INTERPOLATED_POSITION) && !defined(MANTLE_COVER_BASELINE_DERIVATIVES)\n  if (any(notEqual(vCoverDerivatives, vec4(0.0))))\n#else\n  if (false)\n#endif\n    emCoord = vCoverZero',
      );
  // Coverage RTs sum positive sub-byte contributions before paint. The
  // normal RGBA8 paint discard cannot be applied to individual pieces.
  for (const key of Object.keys(shaders))
    shaders[key] = shaders[key].replace(
      '  if (color.a < 1.0/255.0) discard;',
      '#ifdef MANTLE_COVERAGE_ACCUMULATION\n  if (color.a <= 0.0) discard;\n#elif defined(MANTLE_COVER_HALF_BYTE_ALPHA)\n#ifdef MANTLE_LB_FILL\n  if(color.a < (vKind<0.0 ? 0.5 : 1.0)/255.0) discard;\n#else\n  if(color.a < 0.5/255.0) discard;\n#endif\n#else\n  if (color.a < 1.0/255.0) discard;\n#endif',
    );
  // Current production cutoff, with an explicit old-paint counterfactual.
  for (const key of Object.keys(shaders))
    shaders[key] = shaders[key].replace(
      '  if (color.a < alphaCutoff) discard;',
      '#ifdef MANTLE_COVERAGE_ACCUMULATION\n  if(color.a <= 0.0) discard;\n#else\n#ifdef MANTLE_PAINT_ALPHA_BASELINE\n  alphaCutoff=1.0/255.0;\n#endif\n  if (color.a < alphaCutoff) discard;\n#endif',
    );
  // Float-bit readback from the actual fragment, for the isolated tiger hole.
  for (const key of Object.keys(shaders))
    if (
      shaders[key].includes('out vec4 fragColor;') &&
      shaders[key].includes('float cpatchCoverage()')
    ) {
      let code = '';
      for (const first of [24, 31, 292, 301])
        for (const [name, expr] of Object.entries({
          X: 'vEm.x',
          Y: 'vEm.y',
          QX: 'cpProbePoint().x',
          QY: 'cpProbePoint().y',
          EPP: 'vEmPerPx',
          REJ: `cpProbeReject(${first})`,
        }))
          code += `\n#if defined(MANTLE_CPATCH) && defined(MANTLE_CP_QUERY_${first}_${name})\n  if(int(cCen.x+0.5)!=${first}) discard;\n  uint u_=floatBitsToUint(${expr});\n  fragColor=vec4(uvec4(u_ & 255u,(u_>>8u)&255u,(u_>>16u)&255u,u_>>24u))/255.0; return;\n#endif\n`;
      const helper = `#ifdef MANTLE_CPATCH\nvec2 cpProbePoint(){
#if defined(MANTLE_CPATCH_PIXEL_COORD) && !defined(MANTLE_CP_AFFINE_COORD)
  vec2 ndc=2.0*(gl_FragCoord.xy+uFragOrigin)/uViewportSize-1.0;
  vec3 q=vCpClipToLocal*vec3(ndc,1.0);return q.xy/q.z;
#else
  return vEm;
#endif
}
float cpProbeReject(int first) { for(int i=0;i<8;i++){ if(i>=int(cCen.y+0.5))break; if(cpatchCurveCov(first+i,vEm,vEmPerPx)<0.5)return float(i); } return -1.0; }\n#endif\n`;
      shaders[key] = shaders[key].replace('void main() {', helper + 'void main() {' + code);
    }
  for (const key of Object.keys(shaders)) {
    let code = '';
    for (const [name, expr] of Object.entries({
      X: 'emCoord.x',
      Y: 'emCoord.y',
      EPX: 'ePx.x',
      EPY: 'ePx.y',
      DXX: 'emDx.x',
      DXY: 'emDx.y',
      DYX: 'emDy.x',
      DYY: 'emDy.y',
    }))
      code += `\n#ifdef MANTLE_AREA_QUERY_${name}\n  uint u_=floatBitsToUint(${expr});fragColor=vec4(uvec4(u_ & 255u,(u_>>8u)&255u,(u_>>16u)&255u,u_>>24u))/255.0;return;\n#endif\n`;
    const anchor = '  vec2 invPx = 1.0 / max(ePx, vec2(1e-30));';
    shaders[key] = shaders[key].replace(anchor, anchor + code);
  }
  return shaders;
}
