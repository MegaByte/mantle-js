#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feSpecularLighting / feDiffuseLighting — Phong-shaded surface
// generated from input alpha treated as a height field. SVG Filter
// Effects §18 mandates classic Lambertian diffuse + Phong specular
// (no PBR substitution allowed for spec compliance).
//
// Surface normal at pixel (x,y):
//   h(x,y) = surfaceScale · input.a(x,y)
//   ∂h/∂x ≈ Sobel-x gradient over a 3×3 neighborhood
//   ∂h/∂y ≈ Sobel-y gradient
//   N = normalize(-∂h/∂x, -∂h/∂y, 1)
//
// Diffuse:    out.rgb = ka · lightColor.rgb · max(0, N·L)
// Specular:   out.rgb = ks · lightColor.rgb · pow(max(0, N·H), exponent)
//             where H = normalize(L + V), V = (0, 0, 1) at the viewer.
// Output alpha:
//   Diffuse: alpha = computed luminance (= max channel by spec)
//   Specular: alpha = max channel of output rgb (spec §18.2)
//
// Light types (uLightType):
//   0 = distant: L is constant from (azimuth, elevation)
//   1 = point:   L = normalize((lightPos.xyz) - (x, y, 0))
//   2 = spot:    L as point + cone falloff toward pointsAt
//
// uMode:
//   0 = diffuse (uK = diffuseConstant, uExponent unused)
//   1 = specular (uK = specularConstant, uExponent = specularExponent)
precision highp float;
uniform sampler2D uIn;      // input (alpha = height field)
uniform vec2  uTexel;       // 1 / inRect.size — one CANVAS pixel, in input uv
uniform vec4  uInMap;       // vUV → input uv (see @@FILTER_RECT@@)
uniform vec4  uOutRect;     // this pass's canvas rect (origin.xy, size.xy) in px
uniform vec2  uWorldScale;  // per-draw worldMatrix scale (X,Y); 1.0 = identity.
                            // The height-field gradient is sampled over
                            // device texels, so when a draw's worldMatrix
                            // scales the shape up the alpha edge spans more
                            // texels and the per-texel slope shrinks. Folding
                            // worldScale back in keeps surface relief — and
                            // thus lighting — invariant under world scale.
uniform float uSurfaceScale;
uniform float uK;           // diffuseConstant OR specularConstant
uniform float uExponent;    // specularExponent (specular only)
uniform vec4  uLightColor;  // light source RGB color (premultiplied source-side semantics)
uniform int   uMode;        // 0 diffuse, 1 specular
uniform int   uLightType;   // 0 distant, 1 point, 2 spot
// GL SPACE throughout (x right, y UP, z toward the viewer; origin bottom-left): the surface normal below is built
// from uv steps, which run up the canvas, so the light has to be in the same frame. primitives/lighting.js converts
// from SVG space (y down): a distant direction has its y negated, a point/spot position and pointsAt go through
// the renderer's em -> px chain and flip.
uniform vec3  uLightPos;    // point/spot position in GL canvas pixels OR distant (Lx, Ly, Lz) direction
uniform vec3  uSpotAt;      // spot pointsAt, GL canvas pixels
uniform float uSurfaceZ;    // pixels of surface height per unit of alpha (surfaceScale * px per user unit): the surface point's z (Filter Effects 1: Z(x,y) = surfaceScale * A(x,y))
uniform float uSpotExp;     // spot specularExponent (cone falloff)
uniform float uSpotCosCone; // cos(limitingConeAngle); >1.0 means no cone
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

void main() {
  vec2 uv = mapIn(vUV, uInMap);

  float scale = uSurfaceScale * 0.25;
  // Sample alpha at the 8 neighbors (the center carries no weight in either kernel).
  // Layout (row-major):  TL T TR
  //                       L C  R
  //                      BL B BR
  float aC  = uLightType == 0 ? 0.0 : sampleIn(uIn, uv).a;   // the surface point's height: only a point or spot light reads it
  float aTL = sampleIn(uIn, uv + uTexel * vec2(-1.0, -1.0)).a;
  float aT  = sampleIn(uIn, uv + uTexel * vec2( 0.0, -1.0)).a;
  float aTR = sampleIn(uIn, uv + uTexel * vec2( 1.0, -1.0)).a;
  float aL  = sampleIn(uIn, uv + uTexel * vec2(-1.0,  0.0)).a;
  float aR  = sampleIn(uIn, uv + uTexel * vec2( 1.0,  0.0)).a;
  float aBL = sampleIn(uIn, uv + uTexel * vec2(-1.0,  1.0)).a;
  float aB  = sampleIn(uIn, uv + uTexel * vec2( 0.0,  1.0)).a;
  float aBR = sampleIn(uIn, uv + uTexel * vec2( 1.0,  1.0)).a;

  float Nx = scale * uWorldScale.x * ((aTR + 2.0 * aR + aBR) - (aTL + 2.0 * aL + aBL));
  float Ny = scale * uWorldScale.y * ((aBL + 2.0 * aB + aBR) - (aTL + 2.0 * aT + aTR));
  vec3 N = normalize(vec3(-Nx, -Ny, 1.0));

  // Compute light direction L and per-light intensity scaling.
  vec3 L;
  float lightScale = 1.0;
  if (uLightType == 0) {
    // distant: the importer's direction (unit; normalized here all the same)
    L = normalize(uLightPos);
  } else {
    // point or spot
    // Light positions are in CANVAS pixels, so the surface point must be too —
    // vUV alone is relative to whatever rect this pass happens to cover.
    vec3 pos = vec3(uOutRect.xy + vUV * uOutRect.zw, uSurfaceZ * aC);
    vec3 toLight = uLightPos - pos;
    L = normalize(toLight);
    if (uLightType == 2) {

      vec3 toAt = uSpotAt - uLightPos;
      float atLen = length(toAt);
      vec3 axis = atLen > 0.0 ? toAt / atLen : vec3(0.0);
      float cosLight = dot(-L, axis);
      // uSpotCosCone > 1 is the importer's "no limitingConeAngle" sentinel (2.0). Testing it as a
      // cosine zeroed every cone-less spot light, since no cosine exceeds 1. And a
      // surface the light points away from gets nothing rather than pow() of a negative base,
      // which GLSL leaves undefined -- the case for any cone wider than 90 degrees, or none.
      if ((uSpotCosCone <= 1.0 && cosLight < uSpotCosCone) || cosLight <= 0.0) {
        lightScale = 0.0;
      } else {
        lightScale = pow(cosLight, uSpotExp);
        // SVG 1.1 feSpotLight limitingConeAngle: "user agents should apply a smoothing technique such as anti-aliasing at the boundary of
        // the cone". The ramp is Skia's (and so Chrome's): linear in the cosine over its last 0.016, so a cone edge is about a pixel wide.
        if (uSpotCosCone <= 1.0) lightScale *= clamp((cosLight - uSpotCosCone) * 62.5, 0.0, 1.0);
      }
    }
  }

  vec3 lightCol = uLightColor.rgb * lightScale;
  vec3 outRgb;
  float outA;
  if (uMode == 0) {
    // diffuse
    float NdotL = max(0.0, dot(N, L));
    outRgb = uK * lightCol * NdotL;
    // spec §18.1: alpha = 1.0 (the diffuse output is fully opaque).
    outA = 1.0;
  } else {
    // specular: half-vector with viewer at (0, 0, 1)
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float NdotH = max(0.0, dot(N, H));
    outRgb = uK * lightCol * pow(NdotH, uExponent);
    // spec §18.2: alpha = max(r, g, b) of the output (so specular
    // highlights also drive the alpha channel for downstream
    // compositing).
    outA = max(outRgb.r, max(outRgb.g, outRgb.b));
  }
  outRgb = clamp(outRgb, 0.0, 1.0);
  outA   = clamp(outA, 0.0, 1.0);
  // ALREADY PREMULTIPLIED, both modes. Diffuse has outA = 1. Specular's outA is max(r, g, b), so every
  // channel is <= outA: (outRgb, outA) is a valid premultiplied color as it stands, and it is how
  // Chrome (Skia) packs it. Multiplying by outA again SQUARED the specular result -- 0.75 came out
  // 0.56 against Chrome's rendering of the same filter.
  fragColor = vec4(outRgb, outA);
}
