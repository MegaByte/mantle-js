#version 300 es
precision highp float;
precision highp int;

layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aNormal;

layout(location=2) in vec2 aEmCoord;
layout(location=7) in float aShapeIdx;
out vec2 vEmCoord;
out vec4 vOverrideTint;     

flat out int vOverrideMask; 
out vec4 vOverrideFill;     
out vec4 vOverrideStroke;   
out float vOverrideStrokeWidth;  
flat out int vInst;
uniform sampler2D uMetaTex;

const int MT_BBOX         = 0;   
const int MT_FILL         = 1;   
const int MT_STROKE       = 2;   
const int MT_STROKE_PARAMS = 3;  
const int MT_GLYPH_BAND   = 4;   
const int MT_SOLID        = 5;   
const int MT_CAP_JOIN     = 6;   
const int MT_PAINT_ID     = 7;   
const int MT_FILTER_BLEND = 8;   
const int MT_IMAGE_RECT   = 9;   
const int MT_ATLAS        = 10;  
const int MT_PRIM         = 11;  

const int FT_R0   = 0;   
const int FT_R1   = 1;
const int FT_R2   = 2;
const int FT_R3   = 3;
const int FT_OFF  = 4;   
const int FT_META = 5;   

const int GR_G0 = 0;  const int GR_G1 = 1;  const int GR_G2 = 2;  const int GR_G3 = 3;

const int OV_AFFINE   = 0;  
const int OV_POS_VIS  = 1;  
const int OV_TINT     = 2;
const int OV_FILL     = 3;
const int OV_STROKE   = 4;
const int OV_STROKE_W = 5;

const int DASH_HDR = 0;

const int MRL_ROW = 0;

uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
uniform vec2 uViewportSize;
uniform float uNumShapes;

uniform int uShapeIdxOverride;

uniform int uHasEmCoord;

uniform sampler2D uOverrideTex;
uniform int uHasOverrides;

uniform float uDrawAlpha;

uniform mat3 uWorldM;
uniform int uHasWorldM;
#ifdef MANTLE_LB_COV

uniform vec4 uCoverBBox;
#endif

#ifdef MANTLE_INSTANCED
layout(location=8)  in vec3 aInstW0;   
layout(location=9)  in vec3 aInstW1;   
layout(location=10) in vec3 aInstW2;   
layout(location=11) in float aInstAlpha;
#endif

vec4 emRow0() {
  float sx = uCanvasAR.x * 2.0 / uGlobalBBox.z;
  return vec4(sx, 0.0, 0.0, -uCanvasAR.x - 2.0 * uGlobalBBox.x * uCanvasAR.x / uGlobalBBox.z);
}
vec4 emRow1() {
  float sy = -uCanvasAR.y * 2.0 / uGlobalBBox.w;
  return vec4(0.0, sy, 0.0, uCanvasAR.y + 2.0 * uGlobalBBox.y * uCanvasAR.y / uGlobalBBox.w);
}
vec4 emRow3() {
  
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec2 coverQuadDilate(vec2 emPos, vec2 normal,
                vec4 m0, vec4 m1, vec4 m3,
                vec2 viewportPx) {
  if (dot(normal, normal) < 1e-12) return vec2(0.0);
  vec2 nHat = normalize(normal);
  float s = dot(m3.xy, emPos) + m3.w;
  float t = dot(m3.xy, nHat);
  float u = (s * dot(m0.xy, nHat) - t * (dot(m0.xy, emPos) + m0.w)) * viewportPx.x;
  float v = (s * dot(m1.xy, nHat) - t * (dot(m1.xy, emPos) + m1.w)) * viewportPx.y;
  float s2 = s * s;
  float st = s * t;
  float uv = u * u + v * v;
  float denom = uv - st * st;
  if (abs(denom) < 1e-12) return vec2(0.0);
  return normal * (s2 * (st + sqrt(uv)) / denom);
}

void main() {
  int shapeIdx = (uShapeIdxOverride >= 0) ? uShapeIdxOverride : int(aShapeIdx + 0.5);
  vInst = shapeIdx;

  
  
  
#ifdef MANTLE_INSTANCED
  mat3  wWorldM    = mat3(aInstW0, aInstW1, aInstW2);
  int   wHasWorldM = 1;
  float wDrawAlpha = aInstAlpha;
#else
  mat3  wWorldM    = uWorldM;
  int   wHasWorldM = uHasWorldM;
  float wDrawAlpha = uDrawAlpha;
#endif

  
  
  
  vec2 ovPos = vec2(0.0);
  mat2 ovBasis = mat2(1.0, 0.0, 0.0, 1.0);
  float ovVis = 1.0;
  vec4 ovTint = vec4(1.0);
  int ovMask = 0;
  vec4 ovFill = vec4(0.0);
  vec4 ovStrk = vec4(0.0);
  float ovStrkW = 0.0;
  if (uHasOverrides == 1) {
    vec4 ovAff  = texelFetch(uOverrideTex, ivec2(OV_AFFINE, shapeIdx), 0); 
    vec4 ovP    = texelFetch(uOverrideTex, ivec2(OV_POS_VIS, shapeIdx), 0); 
    ovTint      = texelFetch(uOverrideTex, ivec2(OV_TINT, shapeIdx), 0);
    
    ovBasis = mat2(ovAff.x, ovAff.z,
                   ovAff.y, ovAff.w);
    ovPos = ovP.xy;
    ovVis = clamp(ovP.z, 0.0, 1.0);
    ovMask = int(ovP.w + 0.5);
    
    
    
    
    if ((ovMask & 1) != 0) ovFill   = texelFetch(uOverrideTex, ivec2(OV_FILL, shapeIdx), 0);
    if ((ovMask & 2) != 0) ovStrk   = texelFetch(uOverrideTex, ivec2(OV_STROKE, shapeIdx), 0);
    if ((ovMask & 4) != 0) ovStrkW  = texelFetch(uOverrideTex, ivec2(OV_STROKE_W, shapeIdx), 0).x;
  }
  
  
  
  
  
  
  ovTint.a *= wDrawAlpha * ovVis;
  vOverrideTint = ovTint;
  vOverrideMask = ovMask;
  vOverrideFill = ovFill;
  vOverrideStroke = ovStrk;
  vOverrideStrokeWidth = ovStrkW;

  
  
  if (ovVis <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vEmCoord = vec2(0.0);
    return;
  }

  
  
  
  
  
  
  
  
  
  
  
  
  vec4 e0 = emRow0(), e1 = emRow1();
  vec4 m0, m1, m3;
  if (wHasWorldM == 1) {
    m0 = wWorldM[0][0] * e0 + wWorldM[1][0] * e1;  m0.w += wWorldM[2][0];
    m1 = wWorldM[0][1] * e0 + wWorldM[1][1] * e1;  m1.w += wWorldM[2][1];
    m3 = wWorldM[0][2] * e0 + wWorldM[1][2] * e1;  m3.w += wWorldM[2][2];
  } else {
    m0 = e0; m1 = e1; m3 = emRow3();
  }
  
  
  
  
  
  
  
  
  if (uHasOverrides == 1) {
    m0.xy = m0.xy * ovBasis;
    m1.xy = m1.xy * ovBasis;
  }
  
  
  
  
  vec2 lbPos = aPos;
#ifdef MANTLE_LB_COV
  lbPos = mix(uCoverBBox.xy, uCoverBBox.zw, aPos);
#endif
  vec2 dEm = coverQuadDilate(lbPos, aNormal, m0, m1, m3, uViewportSize);
  vec2 emDilated = lbPos + dEm;
  
  
  vec2 emTransformed = (uHasOverrides == 1)
    ? ovBasis * emDilated + ovPos
    : emDilated;
  
  
  
  
  
  
  
  
  if (uHasEmCoord == 1) {
    vec2 emSampled = (uHasOverrides == 1)
      ? ovBasis * aEmCoord + ovPos
      : aEmCoord;
    vEmCoord = emSampled;
  } else {
    vEmCoord = emTransformed;
  }

  vec2 uv = (emTransformed - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  float z = (uNumShapes > 0.0) ? (1.0 - float(shapeIdx) / uNumShapes) : 0.0;
  
  
  
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (wHasWorldM == 1) {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    vec4 cj = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, shapeIdx), 0);
    int flagsShape = int(cj.w + 0.5);
    bool nonScalingSize = (flagsShape & 1024) != 0;
    bool nonRotation    = (flagsShape & 2048) != 0;
    bool fixedPosition  = (flagsShape & 4096) != 0;
    if (nonScalingSize || nonRotation || fixedPosition) {
      
      
      vec4 bb = texelFetch(uMetaTex, ivec2(MT_BBOX, shapeIdx), 0);
      vec2 anchorEm = vec2((bb.x + bb.z) * 0.5, (bb.y + bb.w) * 0.5);
      vec2 anchorUV = (anchorEm - uGlobalBBox.xy) / uGlobalBBox.zw;
      vec2 anchorPlane = (anchorUV * 2.0 - 1.0) * uCanvasAR;
      vec2 anchorClip = vec2(anchorPlane.x, -anchorPlane.y);

      
      
      float m00 = wWorldM[0][0], m10 = wWorldM[0][1];
      float m01 = wWorldM[1][0], m11 = wWorldM[1][1];
      vec2 t    = wWorldM[2].xy;
      
      
      
      float scale = max(sqrt(m00 * m00 + m10 * m10), 1e-6);
      float cR = m00 / scale, sR = m10 / scale;
      
      
      
      
      vec2 effScale = nonScalingSize ? vec2(1.0) : vec2(scale);
      mat2 effR = nonRotation
        ? mat2(1.0, 0.0, 0.0, 1.0)
        : mat2(cR, sR, -sR, cR);  
      vec2 effT = fixedPosition ? vec2(0.0) : t;

      
      vec2 d = clip3.xy - anchorClip;
      d *= effScale;
      d = effR * d;
      clip3.xy = d + anchorClip + effT;
    } else {
      clip3 = wWorldM * clip3;
    }
  }
  gl_Position = vec4(clip3.xy, z, clip3.z);
}
