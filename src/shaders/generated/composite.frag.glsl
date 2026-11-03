#version 300 es

precision highp float;
uniform sampler2D uShapeTex;
uniform sampler2D uDstTex;
uniform vec4 uShapeMap;
uniform vec4 uDstMap;
uniform int uBlendMode;
uniform float uOpacity;
in vec2 vUV;
out vec4 fragColor;

vec3 unpre(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : c.rgb; }

vec3 blendSeparable(int mode, vec3 src, vec3 dst) {
  if (mode == 1)  return src * dst;
  if (mode == 2)  return src + dst - src * dst;
  if (mode == 3) {
    vec3 lo = 2.0 * src * dst;
    vec3 hi = 1.0 - 2.0 * (1.0 - src) * (1.0 - dst);
    return mix(lo, hi, step(0.5, dst));
  }
  if (mode == 4)  return min(src, dst);
  if (mode == 5)  return max(src, dst);
  if (mode == 6) {

    vec3 d6 = mix(min(vec3(1.0), dst / max(1.0 - src, 1e-6)),
                  vec3(1.0), step(1.0, src));
    return mix(d6, vec3(0.0), step(dst, vec3(0.0)));
  }
  if (mode == 7) {

    vec3 b7 = mix(1.0 - min(vec3(1.0), (1.0 - dst) / max(src, 1e-6)),
                  vec3(0.0), step(src, vec3(0.0)));
    return mix(b7, vec3(1.0), step(1.0, dst));
  }
  if (mode == 8) {
    vec3 lo = 2.0 * src * dst;
    vec3 hi = 1.0 - 2.0 * (1.0 - src) * (1.0 - dst);
    return mix(lo, hi, step(0.5, src));
  }
  if (mode == 9) {
    vec3 d = mix(((16.0*dst - 12.0)*dst + 4.0)*dst, sqrt(dst), step(0.25, dst));
    vec3 lo = dst - (1.0 - 2.0*src) * dst * (1.0 - dst);
    vec3 hi = dst + (2.0*src - 1.0) * (d - dst);
    return mix(lo, hi, step(0.5, src));
  }
  if (mode == 10) return abs(dst - src);
  if (mode == 11) return src + dst - 2.0 * src * dst;

  if (mode == 16) return min(src + dst, vec3(1.0));
  if (mode == 17) return max(dst - src, vec3(0.0));
  if (mode == 18) return vec3(1.0) - dst;
  return src;
}

float lum(vec3 c) { return 0.3*c.r + 0.59*c.g + 0.11*c.b; }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0)  c = l + ((c - l) * l) / (l - n);
  if (x > 1.0)  c = l + ((c - l) * (1.0 - l)) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float cmin = min(min(c.r, c.g), c.b);
  float cmax = max(max(c.r, c.g), c.b);
  if (cmax - cmin > 0.0) return (c - cmin) * (s / (cmax - cmin));
  return vec3(0.0);
}
vec3 blendNonSeparable(int mode, vec3 src, vec3 dst) {
  if (mode == 12) return setLum(setSat(src, sat(dst)), lum(dst));
  if (mode == 13) return setLum(setSat(dst, sat(src)), lum(dst));
  if (mode == 14) return setLum(src, lum(dst));
  if (mode == 15) return setLum(dst, lum(src));
  return src;
}

vec3 blendDispatch(int mode, vec3 src, vec3 dst) {
  return (mode >= 12 && mode <= 15)
    ? blendNonSeparable(mode, src, dst)
    : blendSeparable(mode, src, dst);
}

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

vec3 csSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 csLinearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec4 csConvert(vec4 p, int mode) {
  if (mode == 0 || p.a <= 0.0) return p;
  vec3 c = clamp(p.rgb / p.a, 0.0, 1.0);
  c = mode == 1 ? csSrgbToLinear(c) : csLinearToSrgb(c);
  return vec4(c * p.a, p.a);
}

void main() {

  vec4 srcPre = sampleIn(uShapeTex, mapIn(vUV, uShapeMap));
  vec4 dstPre = sampleIn(uDstTex,   mapIn(vUV, uDstMap));

  float opacity = max(uOpacity, 0.0);
  srcPre = srcPre * opacity;

  if (uBlendMode == 19) {
    fragColor = min(srcPre + dstPre, vec4(1.0));
    return;
  }

  if (uBlendMode == 20) {
    float outA = srcPre.a * dstPre.a;
    fragColor = vec4(unpre(dstPre) * outA, outA);
    return;
  }
  if (uBlendMode == 21) {
    float outA = (1.0 - srcPre.a) * dstPre.a;
    fragColor = vec4(unpre(dstPre) * outA, outA);
    return;
  }

  vec3 src = unpre(srcPre);
  vec3 dst = unpre(dstPre);
  float as = srcPre.a, ad = dstPre.a;
  vec3 b = blendDispatch(uBlendMode, src, dst);

  vec3 outRgb = (1.0 - ad) * src + ad * b;

  vec3 co = as * outRgb + ad * (1.0 - as) * dst;
  float finalA = as + ad - as * ad;
  fragColor = vec4(co, finalA);
}
