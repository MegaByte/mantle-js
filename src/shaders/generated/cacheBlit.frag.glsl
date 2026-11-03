#version 300 es

precision highp float;
uniform sampler2D uCacheTex;
uniform int uOutputChannel;
#ifdef CB_INSTANCED
flat in vec4 vTint;
#else
uniform vec4 uTint;
#endif
in vec2 vUV;
out vec4 fragColor;

#ifdef FILTER_CS_OUT

vec4 csToSrgb(vec4 p) {
  if (p.a <= 0.0) return p;
  vec3 c = clamp(p.rgb / p.a, 0.0, 1.0);
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  return vec4(c * p.a, p.a);
}
#endif

#ifdef FILTER_REGION_QUAD

uniform vec3 uRegionEdges[4];
#endif

void main() {

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
