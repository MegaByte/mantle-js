#version 300 es

precision highp float;
uniform sampler2D uIn;      
uniform vec2  uTexel;       
uniform vec2  uWorldScale;  
                            
                            
                            
                            
                            
                            
uniform float uSurfaceScale;
uniform float uK;           
uniform float uExponent;    
uniform vec4  uLightColor;  
uniform int   uMode;        
uniform int   uLightType;   
uniform vec3  uLightPos;    
uniform vec3  uSpotAt;      
uniform float uSpotExp;     
uniform float uSpotCosCone; 
in vec2 vUV;
out vec4 fragColor;

void main() {
  
  
  
  
  
  float scale = uSurfaceScale * 0.25;
  
  
  
  
  float aTL = texture(uIn, vUV + uTexel * vec2(-1.0, -1.0)).a;
  float aT  = texture(uIn, vUV + uTexel * vec2( 0.0, -1.0)).a;
  float aTR = texture(uIn, vUV + uTexel * vec2( 1.0, -1.0)).a;
  float aL  = texture(uIn, vUV + uTexel * vec2(-1.0,  0.0)).a;
  float aC  = texture(uIn, vUV).a;
  float aR  = texture(uIn, vUV + uTexel * vec2( 1.0,  0.0)).a;
  float aBL = texture(uIn, vUV + uTexel * vec2(-1.0,  1.0)).a;
  float aB  = texture(uIn, vUV + uTexel * vec2( 0.0,  1.0)).a;
  float aBR = texture(uIn, vUV + uTexel * vec2( 1.0,  1.0)).a;
  
  
  float Nx = scale * uWorldScale.x * ((aTR + 2.0 * aR + aBR) - (aTL + 2.0 * aL + aBL));
  float Ny = scale * uWorldScale.y * ((aBL + 2.0 * aB + aBR) - (aTL + 2.0 * aT + aTR));
  vec3 N = normalize(vec3(-Nx, -Ny, 1.0));

  
  vec3 L;
  float lightScale = 1.0;
  if (uLightType == 0) {
    
    L = normalize(uLightPos);
  } else {
    
    vec3 pos = vec3(vUV / uTexel, 0.0);  
    vec3 toLight = uLightPos - pos;
    L = normalize(toLight);
    if (uLightType == 2) {
      
      
      
      vec3 axis = normalize(uSpotAt - uLightPos);
      float cosLight = dot(-L, axis);
      if (cosLight < uSpotCosCone) {
        
        lightScale = 0.0;
      } else {
        lightScale = pow(cosLight, uSpotExp);
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
    
    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 H = normalize(L + V);
    float NdotH = max(0.0, dot(N, H));
    outRgb = uK * lightCol * pow(NdotH, uExponent);
    
    
    
    outA = max(outRgb.r, max(outRgb.g, outRgb.b));
  }
  outRgb = clamp(outRgb, 0.0, 1.0);
  outA   = clamp(outA, 0.0, 1.0);
  
  fragColor = vec4(outRgb * outA, outA);
}
