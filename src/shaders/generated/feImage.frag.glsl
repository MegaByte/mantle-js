#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn;
uniform vec2 uAtlasSize;
uniform vec4 uAtlasRect;     
uniform int  uPreserveAR;    
in vec2 vUV;                 
out vec4 fragColor;
void main() {
  vec2 uv = vUV;
  
  
  if (uPreserveAR == 1) {
    float srcAR = uAtlasRect.y / max(uAtlasRect.z, 1.0);   
    
    
    float dstAR = 1.0;
    if (srcAR > dstAR) {
      
      float k = dstAR / srcAR;
      uv.y = (uv.y - 0.5) / k + 0.5;
    } else {
      float k = srcAR / dstAR;
      uv.x = (uv.x - 0.5) / k + 0.5;
    }
  }
  
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  float atlasU = (uv.x * uAtlasRect.y) / max(uAtlasSize.x, 1.0);
  float atlasV = (uAtlasRect.x + uv.y * uAtlasRect.z) / max(uAtlasSize.y, 1.0);
  vec4 c = texture(uIn, vec2(atlasU, atlasV));
  
  fragColor = vec4(c.rgb * c.a, c.a);
}
