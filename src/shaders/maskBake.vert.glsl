#version 300 es
// Emits a 4-vertex quad covering the mask region's em-bbox, mapped into
// canvas-NDC using the SAME em→NDC transform as the main vertex shader
// (uGlobalBBox + uCanvasAR). The bake layer is allocated canvas-sized,
// so sampling in the fragment shader uses gl_FragCoord.xy / uViewportSize
// and the result lines up 1:1 with the main draw's fragment positions.
precision highp float;

layout(location=0) in vec2 aUV;          // (0,0)..(1,1) — local corner of region quad
uniform vec4 uMaskEmBBox;                // (xmin, ymin, xmax, ymax) — region em-bbox
uniform vec4 uGlobalBBox;                // canvas em-bbox (xmin, ymin, w, h)
uniform vec2 uCanvasAR;                  // aspect-preserving scale (matches main vertex shader)
out vec2 vEmCoord;

void main() {
  vec2 emPos = mix(uMaskEmBBox.xy, uMaskEmBBox.zw, aUV);
  vEmCoord = emPos;
  vec2 uv    = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  // Y-flip matches the main vertex shader (SVG y-down → GL bottom-up).
  gl_Position = vec4(plane.x, -plane.y, 0.0, 1.0);
}
