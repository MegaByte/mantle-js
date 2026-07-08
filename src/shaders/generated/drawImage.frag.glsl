#version 300 es

precision highp float;

uniform sampler2D uTex;
uniform vec4  uTint;    
uniform float uAlpha;   

in  vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 src = texture(uTex, vUV);     
  
  
  
  float a = uTint.a * uAlpha;
  fragColor = vec4(src.rgb * uTint.rgb * a, src.a * a);
}
