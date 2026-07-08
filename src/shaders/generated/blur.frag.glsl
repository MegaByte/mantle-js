#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;     
uniform vec2  uDir;       
uniform float uSigma;     
in vec2 vUV;
out vec4 fragColor;

void main() {
  if (uSigma <= 0.5) { fragColor = texture(uTex, vUV); return; }
  float twoS2 = 2.0 * uSigma * uSigma;
  
  int radius = int(min(ceil(uSigma * 3.0), 32.0));
  
  vec4 acc = texture(uTex, vUV);
  float wsum = 1.0;
  
  
  for (int k = 0; k < 16; ++k) {
    int i0 = 2 * k + 1;
    int i1 = i0 + 1;
    if (i0 > radius) break;
    float w0 = exp(-float(i0 * i0) / twoS2);
    
    
    float w1 = (i1 <= radius) ? exp(-float(i1 * i1) / twoS2) : 0.0;
    float wPair = w0 + w1;
    
    
    float offset = (float(i0) * w0 + float(i1) * w1) / wPair;
    vec2 d = uDir * uTexel * offset;
    acc += texture(uTex, vUV + d) * wPair;
    acc += texture(uTex, vUV - d) * wPair;
    wsum += 2.0 * wPair;
  }
  fragColor = acc / wsum;
}
