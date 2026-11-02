// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Probe-only current-pose extrema preparation. No curve subdivision and no
// CPatch pieces: the original AAC paint/composition path remains in charge.
import { noteExternalGlWrite } from '../../src/core/glEpoch.js';
export function addRootCacheVariant(shaders) {
  const out = { ...shaders };
  for (const key of Object.keys(out)) {
    let s = out[key];
    if (!s.includes('float aacWalkBand(')) continue;
    s = s.replace(
      /precision highp float;/,
      'precision highp float;\n#ifdef MANTLE_AAC_ROOT_CACHE\nuniform highp sampler2D uAacRoots;\nvec4 aacCachedExtrema;\n#endif\n',
    );
    for (const [line, field] of [
      ['vec2 ex = aacQuadRoots(3.0 * CX.x, 2.0 * CX.y, CX.z);', 'xy'],
      ['vec2 ey = aacQuadRoots(3.0 * CY.x, 2.0 * CY.y, CY.z);', 'zw'],
    ]) {
      const at = s.indexOf(line, s.indexOf('float aacExactI2('));
      if (at < 0) throw Error('Extrema shader anchor missing');
      s =
        s.slice(0, at) +
        `\n#ifdef MANTLE_AAC_ROOT_CACHE\nvec2 ${field === 'xy' ? 'ex' : 'ey'} = aacCachedExtrema.${field};\n#else\n${line}\n#endif\n` +
        s.slice(at + line.length);
    }
    const begin = s.indexOf('float aacWalkBand('),
      end = s.indexOf('float renderFillAAC(', begin);
    if (end < 0) throw Error('AAC walker boundary missing');
    const walk = s
      .slice(begin, end)
      .replaceAll(
        'int sL = int(segRaw.x);',
        'int sL = int(segRaw.x);\n#ifdef MANTLE_AAC_ROOT_CACHE\n    aacCachedExtrema=texelFetch(uAacRoots,ivec2(sL & 4095,sL >> 12),0);\n#endif',
      );
    out[key] = s.slice(0, begin) + walk + s.slice(end);
  }
  return out;
}
export function createRootCache(gl, r, b, scale) {
  if (!gl.getExtension('EXT_color_buffer_float'))
    throw Error('Root cache needs float render targets');
  const start = performance.now(),
    W = 4096,
    H = Math.max(1, Math.ceil(b.curveFloats.length / (W * 4)));
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  const vs = shader(
    gl.VERTEX_SHADER,
    `#version 300 es
  void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`,
  );
  const fs = shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
  precision highp float;uniform sampler2D curves;uniform vec2 scale;out vec4 result;
  vec4 fetch(int i){return texelFetch(curves,ivec2(i & 4095,i >> 12),0);}
  vec2 roots(float a,float b,float c){float disc=b*b-4.*a*c;if(disc<=0.)return vec2(1e9);
    float sq=sqrt(disc),q=-.5*(b+(b<0.?-sq:sq));float r1=abs(a)>1e-30?q/a:1e9,r2=abs(q)>1e-30?c/q:1e9;return vec2(min(r1,r2),max(r1,r2));}
  vec3 coeff(float a,float b,float c,float d,int type){return type==1?vec3(0.,(a-b)+(c-b),2.*(b-a)):vec3((d-a)+3.*(b-c),3.*((a-b)+(c-b)),3.*(b-a));}
  void main(){ivec2 at=ivec2(gl_FragCoord.xy);int i=at.y*4096+at.x;float h=fetch(i).x;result=vec4(1e9);
    if(h<0.||h>=16.||h!=floor(h))return;int type=int(h)&3;if(type!=1&&type!=2)return;
    vec4 ab=fetch(i+1),cd=fetch(i+2);vec2 A=ab.xy*scale,B=ab.zw*scale,C=cd.xy*scale,D=cd.zw*scale;
    vec3 X=coeff(A.x,B.x,C.x,D.x,type),Y=coeff(A.y,B.y,C.y,D.y,type);
    result=vec4(roots(3.*X.x,2.*X.y,X.z),roots(3.*Y.x,2.*Y.y,Y.z));}`,
  );
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const vao = gl.createVertexArray(),
    texture = gl.createTexture(),
    fbo = gl.createFramebuffer(),
    uCurve = gl.getUniformLocation(program, 'curves'),
    uScale = gl.getUniformLocation(program, 'scale');
  gl.activeTexture(gl.TEXTURE15);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, H);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw Error('Root cache framebuffer incomplete');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  noteExternalGlWrite();
  r.invalidateRenderState();
  const locations = new WeakMap();
  return {
    stats: {
      buildMs: performance.now() - start,
      width: W,
      height: H,
      bytes: W * H * 16,
      scope:
        'Compile and allocate current-pose GPU extrema pass; the pass itself runs inside every timed frame',
    },
    draw() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.curveTex);
      gl.uniform1i(uCurve, 0);
      gl.uniform2f(uScale, ...scale);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      noteExternalGlWrite();
      r.invalidateRenderState();
    },
    bind(p) {
      let u = locations.get(p);
      if (u === undefined) {
        u = gl.getUniformLocation(p, 'uAacRoots');
        locations.set(p, u);
      }
      if (u === null) throw Error('AAC root sampler missing');
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(u, 15);
      noteExternalGlWrite();
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(fbo);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}
