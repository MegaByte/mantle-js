#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;     
uniform vec2  uDir;       
uniform float uRadius;    
uniform int   uOperator;  
in vec2 vUV;
out vec4 fragColor;

void main() {
  if (uRadius < 0.5) { fragColor = texture(uTex, vUV); return; }
  
  
  
  
  
  int r = int(min(ceil(uRadius), 64.0));
  
  
  
  
  vec4 acc = texture(uTex, vUV);
  for (int i = 1; i <= 64; ++i) {
    if (i > r) break;
    vec2 d = uDir * uTexel * float(i);
    vec4 p = texture(uTex, vUV + d);
    vec4 n = texture(uTex, vUV - d);
    if (uOperator == 1) {
      acc = max(acc, max(p, n));   
    } else {
      acc = min(acc, min(p, n));   
    }
  }
  fragColor = acc;
}
