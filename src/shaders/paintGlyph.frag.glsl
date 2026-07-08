#version 300 es
// PaintGlyph — clip input by a glyph alpha silhouette.
//
// In the COLRv1 dispatch each PaintGlyph node has two inputs:
//   in[0] = child paint (the fill)
//   in[1] = glyph alpha mask (the silhouette, A only — TextRun renders
//           this into a single-channel RT before evaluation)
// The output is the child modulated by the silhouette alpha. Since the
// graph runs in premultiplied space, we multiply the entire premultiplied
// child by the silhouette alpha (rgb and a both scale).
//
// When TextRun supplies no mask the dispatch attaches a placeholder mask
// of α=1 so the node behaves as a passthrough.

precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform sampler2D uMask;
out vec4 fragColor;

void main() {
  vec4 c = texture(uIn, vUV);
  float m = texture(uMask, vUV).a;
  fragColor = c * m;
}
