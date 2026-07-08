#version 300 es
// drawImage — place a textured unit quad in the viewport.
//
// aPos is a unit quad in [0,1]² (location 0). The vertex is mapped:
//   1. unit quad → destination rect (uDstRect = x,y,w,h in pixels, y-down)
//   2. optional worldMatrix (uWorldM, column-major mat3) for rotation/skew,
//      applied about the dest-rect space (identity by default)
//   3. pixel-space → clip space using the viewport (uViewport = w,h),
//      with the y-flip so dstRect.y is measured from the TOP (SVG
//      convention) while clip-space y points up.
// vUV samples the source sub-rect (uSrcRect = u,v,w,h in [0,1] texture
// coords) so a sprite-sheet / atlas slice can be drawn.
layout(location = 0) in vec2 aPos;   // unit quad corner in [0,1]²

uniform vec4 uDstRect;    // (x, y, w, h) in viewport pixels, y-down
uniform vec4 uSrcRect;    // (u, v, w, h) in [0,1] texture coords
uniform vec2 uViewport;   // (width, height) in pixels
uniform mat3 uWorldM;     // column-major; identity = no extra transform

out vec2 vUV;

void main() {
  // Unit quad → destination pixel rect.
  vec2 px = uDstRect.xy + aPos * uDstRect.zw;
  // Optional world transform (rotation/skew/translate) in pixel space.
  vec3 wp = uWorldM * vec3(px, 1.0);
  px = wp.xy / wp.z;
  // Pixel → NDC. y-flip: pixel y grows downward, clip y grows upward.
  vec2 ndc = vec2(
    (px.x / max(uViewport.x, 1.0)) * 2.0 - 1.0,
    1.0 - (px.y / max(uViewport.y, 1.0)) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  // Source sub-rect.
  vUV = uSrcRect.xy + aPos * uSrcRect.zw;
}
