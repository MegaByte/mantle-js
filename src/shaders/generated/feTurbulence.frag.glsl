#version 300 es

precision highp float;
uniform vec2  uBaseFreq;
uniform int   uNumOctaves;
uniform float uSeed;
uniform int   uKind;
uniform vec2  uTilePos;
uniform vec2  uTileSize;
uniform int   uStitch;
in vec2 vUV;
out vec4 fragColor;

const int   RAND_m  = 2147483647;        
const int   RAND_a  = 16807;
const int   RAND_q  = 127773;
const int   RAND_r  = 2836;
const int   BSize   = 256;

int prngNext(int seed) {
  int result = RAND_a * (seed % RAND_q) - RAND_r * (seed / RAND_q);
  if (result <= 0) result += RAND_m;
  return result;
}

vec2 latticeGradient(int channel, int x, int y, float seed) {
  
  
  float n = float(x) * 12.9898 + float(y) * 78.233
          + float(channel) * 39.346 + seed * 0.7531;
  float h1 = fract(sin(n) * 43758.5453);
  float h2 = fract(sin(n + 7.317) * 24617.8412);
  return vec2(h1, h2) * 2.0 - 1.0;
}

float sCurve(float t) {
  
  return t * t * (3.0 - 2.0 * t);
}

vec4 noise2(vec2 P, float seed) {
  
  vec2 Pi = floor(P);
  vec2 Pf = P - Pi;
  int bx0 = int(Pi.x), bx1 = bx0 + 1;
  int by0 = int(Pi.y), by1 = by0 + 1;
  
  float rx0 = Pf.x;
  float ry0 = Pf.y;
  float sx  = sCurve(rx0);
  float sy  = sCurve(ry0);
  vec4 result;
  for (int ch = 0; ch < 4; ch++) {
    vec2 g00 = latticeGradient(ch, bx0, by0, seed);
    vec2 g10 = latticeGradient(ch, bx1, by0, seed);
    vec2 g01 = latticeGradient(ch, bx0, by1, seed);
    vec2 g11 = latticeGradient(ch, bx1, by1, seed);
    float n00 = dot(g00, vec2(rx0,     ry0));
    float n10 = dot(g10, vec2(rx0 - 1.0, ry0));
    float n01 = dot(g01, vec2(rx0,     ry0 - 1.0));
    float n11 = dot(g11, vec2(rx0 - 1.0, ry0 - 1.0));
    float a = mix(n00, n10, sx);
    float b = mix(n01, n11, sx);
    if      (ch == 0) result.r = mix(a, b, sy);
    else if (ch == 1) result.g = mix(a, b, sy);
    else if (ch == 2) result.b = mix(a, b, sy);
    else              result.a = mix(a, b, sy);
  }
  return result;
}

void main() {
  
  
  vec2 pixelPos = uTilePos + vUV * uTileSize;
  vec2 P = pixelPos * uBaseFreq;
  vec4 acc = vec4(0.0);
  float freq = 1.0;
  float amp  = 1.0;
  
  
  for (int i = 0; i < 6; i++) {
    if (i >= uNumOctaves) break;
    vec4 n = noise2(P * freq, uSeed);
    if (uKind == 0) acc += abs(n) * amp;
    else            acc += n * amp;
    freq *= 2.0;
    amp  *= 0.5;
  }
  vec4 outc;
  if (uKind == 0) {
    
    outc = clamp(acc, 0.0, 1.0);
  } else {
    
    outc = clamp(acc * 0.5 + 0.5, 0.0, 1.0);
  }
  
  
  if (uStitch != 0) {} 
  
  fragColor = vec4(outc.rgb * outc.a, outc.a);
}
