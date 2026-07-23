#version 300 es
// feTile — repeat-tile the input across the filter region.
// Per SVG Filter Effects §15, the input's primitive subregion is the
// tile that gets repeated; fract(uv) wraps UVs into [0,1]. With
// canvas-sized RTs the "tile" is the whole canvas; the shader is also
// correct for sub-canvas inputs that should repeat.
precision highp float;
uniform sampler2D uTex;
uniform vec4 uInMap;   // vUV → input uv (see @@FILTER_RECT@@)
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@
void main() {
  vec2 uv = fract(mapIn(vUV, uInMap));
  if (uv.x < 0.0) uv.x += 1.0;
  if (uv.y < 0.0) uv.y += 1.0;
  fragColor = texture(uTex, uv);
}
