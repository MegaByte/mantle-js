#version 300 es

precision highp float;
uniform sampler2D uIn;
uniform vec2  uTexel;
uniform vec4  uInMap;
uniform vec4  uOutRect;
uniform vec2  uWorldScale;

uniform float uSurfaceScale;
uniform float uK;
uniform float uExponent;
uniform vec4  uLightColor;
uniform int   uMode;
uniform int   uLightType;

uniform vec3  uLightPos;
uniform vec3  uSpotAt;
uniform float uSurfaceZ;
uniform float uSpotExp;
uniform float uSpotCosCone;
in vec2 vUV;
out vec4 fragColor;

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
  vec2 uv = mapIn(vUV, uInMap);

  float scale = uSurfaceScale * 0.25;

  float aC  = uLightType == 0 ? 0.0 : sampleIn(uIn, uv).a;
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

  vec3 L;
  float lightScale = 1.0;
  if (uLightType == 0) {

    L = normalize(uLightPos);
  } else {

    vec3 pos = vec3(uOutRect.xy + vUV * uOutRect.zw, uSurfaceZ * aC);
    vec3 toLight = uLightPos - pos;
    L = normalize(toLight);
    if (uLightType == 2) {

      vec3 toAt = uSpotAt - uLightPos;
      float atLen = length(toAt);
      vec3 axis = atLen > 0.0 ? toAt / atLen : vec3(0.0);
      float cosLight = dot(-L, axis);

      if ((uSpotCosCone <= 1.0 && cosLight < uSpotCosCone) || cosLight <= 0.0) {
        lightScale = 0.0;
      } else {
        lightScale = pow(cosLight, uSpotExp);

        if (uSpotCosCone <= 1.0) lightScale *= clamp((cosLight - uSpotCosCone) * 62.5, 0.0, 1.0);
      }
    }
  }

  vec3 lightCol = uLightColor.rgb * lightScale;
  vec3 outRgb;
  float outA;
  if (uMode == 0) {

    float NdotL = max(0.0, dot(N, L));
    outRgb = uK * lightCol * NdotL;

    outA = 1.0;
  } else {

    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float NdotH = max(0.0, dot(N, H));
    outRgb = uK * lightCol * pow(NdotH, uExponent);

    outA = max(outRgb.r, max(outRgb.g, outRgb.b));
  }
  outRgb = clamp(outRgb, 0.0, 1.0);
  outA   = clamp(outA, 0.0, 1.0);

  fragColor = vec4(outRgb, outA);
}
