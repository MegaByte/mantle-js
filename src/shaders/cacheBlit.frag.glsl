#version 300 es
// Static-scene cache blit. Samples the per-renderer cache texture
// (premultiplied RGBA) and modulates by an optional tint. Replaces
// the full ray-cast for one frame per cache-valid level.
precision highp float;
uniform sampler2D uCacheTex;
uniform vec4 uTint;       // (r,g,b,a) premultiplied; (1,1,1,1) = no tint.
in vec2 vUV;
out vec4 fragColor;
void main() {
  vec4 c = texture(uCacheTex, vUV);
  fragColor = c * uTint;
}
