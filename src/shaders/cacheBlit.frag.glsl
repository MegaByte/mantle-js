#version 300 es
// Static-scene cache blit. Samples the per-renderer cache texture
// (premultiplied RGBA) and modulates by an optional tint. Replaces
// the full ray-cast for one frame per cache-valid level.
precision highp float;
uniform sampler2D uCacheTex;
uniform vec4 uTint;       // (r,g,b,a) premultiplied; (1,1,1,1) = no tint.
uniform vec4 uInMap;      // vUV → uCacheTex uv (see @@FILTER_RECT@@); (1,1,0,0) = whole RT
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

void main() {
  // The blit is drawn over the CONTENT'S rect, not the whole canvas — a cached shape
  // that covers a tenth of the screen has no business rasterizing the other nine. vUV
  // therefore spans that rect, and the map takes it back to where the content sits in
  // the canvas-sized RT.
  vec4 c = texture(uCacheTex, mapIn(vUV, uInMap));
  fragColor = c * uTint;
}
