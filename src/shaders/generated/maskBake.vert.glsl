#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;

layout(location=0) in vec2 aUV;
uniform mat3 uMaskWorld;
uniform int uResourcePatternRow;
uniform vec4 uMaskEmBBox;
uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
uniform vec2 uViewportSize;
out vec2 vEmCoord;
flat out vec4 vMaskPixelBasis;

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

const int FS_STROKE_LOCAL = 4;

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

ivec2 metaAt(int c, int r)   { return ivec2(c + 12 * (r >> 12), r & 4095); }
ivec2 gradAt(int c, int r)   { return ivec2(c + 4 * (r >> 12), r & 4095); }
ivec2 dashAt(int c, int r)   { return ivec2(c + 16 * (r >> 12), r & 4095); }
ivec2 filterAt(int c, int r) { return ivec2(c + 6 * (r >> 12), r & 4095); }
ivec2 ovAt(int c, int r)     { return ivec2(c + 6 * (r >> 12), r & 4095); }
ivec2 mrlAt(int c, int r)    { return ivec2(c + 2 * (r >> 12), r & 4095); }

int metaRowsOf(ivec2 sz) { return sz.y * (sz.x / 12); }

float strokeWidthMultiplier(int flags, vec2 footprint) {
  bool h = (flags & (1 << 13)) != 0, v = (flags & (1 << 14)) != 0;
  if (h && !v) return footprint.x;
  if (v && !h) return footprint.y;
  return (flags & (1 | (1 << 13) | (1 << 14))) != 0 ? 0.5 * (footprint.x + footprint.y) : 1.0;
}

uniform int uMaskChildRow1Based;
flat out vec4 vBB, vFill, vStroke, vGlyph, vStrokePad, vCapJoin, vGrad7, vImgRect, vAtlas, vFrame;

void main() {
  vMaskPixelBasis=vec4(0.0);
  if(uMaskWorld[0].z==0.0&&uMaskWorld[1].z==0.0&&uMaskWorld[2].z!=0.0){
    vec2 r0=vec2(uMaskWorld[0].x,uMaskWorld[1].x),r1=vec2(uMaskWorld[0].y,uMaskWorld[1].y);
    float s0=max(abs(r0.x),abs(r0.y)),s1=max(abs(r1.x),abs(r1.y));
    vec2 n0=s0>0.0?r0/s0:vec2(0.0),n1=s1>0.0?r1/s1:vec2(0.0);
    float d=n0.x*n1.y-n0.y*n1.x;
    if(d!=0.0){
      vec2 frame=uGlobalBBox.zw/uCanvasAR*uMaskWorld[2].z;
      vec2 dx=vec2(n1.y*frame.x,n1.x*frame.y)/(d*s0*uViewportSize.x);
      vec2 dy=vec2(-n0.y*frame.x,-n0.x*frame.y)/(d*s1*uViewportSize.y);
      vMaskPixelBasis=vec4(dx,dy);
    }
  }
  int row = max(uMaskChildRow1Based - 1, 0);
  vBB        = texelFetch(uMetaTex, metaAt(MT_BBOX, row), 0);
  vFill      = texelFetch(uMetaTex, metaAt(MT_FILL, row), 0);
  vStroke    = texelFetch(uMetaTex, metaAt(MT_STROKE, row), 0);
  vGlyph     = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, row), 0);
  vStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, row), 0);
  vec4 cj    = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, row), 0);
  vCapJoin   = vec4(cj.xyz, texelFetch(uMetaTex, metaAt(MT_PRIM, row), 0).z);
  vFrame     = (int(cj.w + 0.5) & FS_STROKE_LOCAL) != 0 ? texelFetch(uMetaTex, metaAt(MT_SOLID, row), 0) : vec4(0.0);
  vec4 g7    = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, row), 0);
  vGrad7     = vec4(g7.xy, texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, row), 0).w, g7.w);
  vImgRect   = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, row), 0);
  vAtlas     = texelFetch(uMetaTex, metaAt(MT_ATLAS, row), 0);
  if (uResourcePatternRow > 0) {

    vec2 ndc = aUV * 2.0 - 1.0;
    vec3 unworld = inverse(uMaskWorld) * vec3(ndc, 1.0);
    vec2 plane = unworld.xy / unworld.z;
    vEmCoord = uGlobalBBox.xy + (vec2(plane.x, -plane.y) / uCanvasAR + 1.0) * .5 * uGlobalBBox.zw;
    gl_Position = vec4(ndc, 0.0, 1.0);
    return;
  }

  vec4 bakeBBox = uResourcePatternRow > 0 ? uMaskEmBBox : vec4(min(uMaskEmBBox.xy, vBB.xy), max(uMaskEmBBox.zw, vBB.zw));

  vec2 bakePixel = uGlobalBBox.zw / (uCanvasAR * max(uViewportSize, vec2(1.0)));
  mat2 world = mat2(uMaskWorld);
  if (determinant(world) != 0.0) {
    mat2 invWorld = inverse(world);
    bakePixel = vec2(abs(invWorld[0].x) / uViewportSize.x + abs(invWorld[1].x) / uViewportSize.y,
      abs(invWorld[0].y) / uViewportSize.x + abs(invWorld[1].y) / uViewportSize.y) * uGlobalBBox.zw / uCanvasAR;
  }

  int strokeFlags = int(cj.w + 0.5);
  float extra = max(0.0, 0.5*vStrokePad.x*(strokeWidthMultiplier(strokeFlags,bakePixel)-1.0));
  int join = int(cj.y + 0.5), cap = int(cj.x + 0.5);
  float ml=max(1.0,cj.z), reach=join==0?ml:(join==3||join==4)?sqrt(ml*ml+1.0):1.0;
  if(cap==2 || int(vCapJoin.w+0.5)==3) reach=max(reach,1.41421356);
  float ramp = 0.0;
  if (vStrokePad.x > 0.0) {
    float halfPixelMean = 0.25 * (bakePixel.x + bakePixel.y);
    float effectiveHalfWidth = 0.5 * vStrokePad.x * strokeWidthMultiplier(strokeFlags, bakePixel);
    ramp = halfPixelMean + max(halfPixelMean - effectiveHalfWidth, 0.0);
  }
  vec2 padding = max(bakePixel, vec2(ramp)) + vec2(extra * reach);
  bakeBBox += vec4(-padding,padding);
  vec2 emPos = mix(bakeBBox.xy, bakeBBox.zw, aUV);
  vEmCoord = emPos;
  vec2 uv    = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;

  vec3 mapped = uMaskWorld * vec3(plane.x, -plane.y, 1.0);
  gl_Position = vec4(mapped.xy, 0.0, mapped.z);
}
