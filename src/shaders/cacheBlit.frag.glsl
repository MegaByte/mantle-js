#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Static-scene cache blit. Samples the per-renderer cache texture
// (premultiplied RGBA) and modulates by an optional tint. Replaces
// the full ray-cast for one frame per cache-valid level.
precision highp float;
uniform sampler2D uCacheTex;
uniform int uOutputChannel; // 0: RGBA, 1: alpha, 2: premultiplied luminance
#ifdef CB_INSTANCED
flat in vec4 vTint;       // the instance's tint (cacheBlitInstanced.vert): a run of group composites is one instanced draw
#else
uniform vec4 uTint;       // (r,g,b,a) premultiplied; (1,1,1,1) = no tint; a group's opacity.
#endif
in vec2 vUV;              // already the texture coordinate: cacheBlit.vert applies uInMap per vertex
out vec4 fragColor;

#ifdef FILTER_CS_OUT
// A filter result tagged linearRGB (filterGraph/colorSpace.js): converted to sRGB as it is composited. Compiled only into the variant program
// a linear result is drawn with, so the program every other blit uses carries nothing.
vec4 csToSrgb(vec4 p) {
  if (p.a <= 0.0) return p;
  vec3 c = clamp(p.rgb / p.a, 0.0, 1.0);
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  return vec4(c * p.a, p.a);
}
#endif

#ifdef FILTER_REGION_QUAD
// A filter region under a turn is no rect the scissor can hold: four edges, a x + b y + c in target pixels, positive inside, scaled so the ramp is one pixel across.
uniform vec3 uRegionEdges[4];
#endif

void main() {
  // The blit is drawn over the CONTENT'S rect, not the whole canvas — a cached shape
  // that covers a tenth of the screen has no business rasterizing the other nine. The
  // vertex stage maps the rect back to where the content sits in the canvas-sized RT.
  vec4 color = texture(uCacheTex, vUV);
#ifdef FILTER_REGION_QUAD
  vec3 fragPx = vec3(gl_FragCoord.xy, 1.0);
  color *= clamp(min(min(dot(uRegionEdges[0], fragPx), dot(uRegionEdges[1], fragPx)), min(dot(uRegionEdges[2], fragPx), dot(uRegionEdges[3], fragPx))) + 0.5, 0.0, 1.0);
#endif
#ifdef FILTER_CS_OUT
  color = csToSrgb(color);
#endif
#ifdef CB_INSTANCED
  color *= vTint;
#else
  color *= uTint;
#endif
  if (uOutputChannel != 0) {
    float value = uOutputChannel == 1 ? color.a : dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    color = vec4(value, value, value, 1.0);
  }
  fragColor = color;
}
