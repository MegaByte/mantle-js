#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec2  uDir;
uniform int   uRadius;     
in vec2 vUV;
out vec4 fragColor;

void main() {
  if (uRadius <= 0) { fragColor = texture(uTex, vUV); return; }
  vec4 acc = texture(uTex, vUV);
  
  
  
  float n = 1.0;
  for (int k = 0; k < 32; ++k) {
    int off = 2 * k + 1;       
    if (off > uRadius) break;
    
    
    float pairCount;            
    float fOff;                 
    if (off + 1 <= uRadius) {
      fOff = float(off) + 0.5;  
      pairCount = 2.0;
    } else {
      fOff = float(off);        
      pairCount = 1.0;
    }
    vec2 d = uDir * uTexel * fOff;
    
    
    acc += texture(uTex, vUV + d) * pairCount;
    acc += texture(uTex, vUV - d) * pairCount;
    n += 2.0 * pairCount;
  }
  fragColor = acc / n;
}
