#version 300 es
// feComposite — Porter-Duff binary compositing (over, in, out, atop,
// xor) plus the SVG-specific `arithmetic` mode. Operates on
// premultiplied RGBA (filter-graph invariant; both inputs expected
// premultiplied).
//
// uOp encoding (matches importer):
//   0 = over   →  porterDuff mode 3   (src over dst)
//   1 = in     →  porterDuff mode 5   (src in)
//   2 = out    →  porterDuff mode 7   (src out)
//   3 = atop   →  porterDuff mode 9   (src atop)
//   4 = xor    →  porterDuff mode 11
//   5 = arithmetic   out = k1·in1·in2 + k2·in1 + k3·in2 + k4
//
// The 5 Porter-Duff entries dispatch through the shared helper in
// _porterDuffHelpers.glsl (also used by paintComposite for the 12
// COLR PD modes). Arithmetic is SVG-specific and stays inline.

precision highp float;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform int uOp;
uniform vec4 uK;          // (k1, k2, k3, k4) for arithmetic mode
in vec2 vUV;
out vec4 fragColor;

@@PORTER_DUFF_HELPERS@@

void main() {
  vec4 a = texture(uIn1, vUV);
  vec4 b = texture(uIn2, vUV);
  if (uOp == 5) {
    // arithmetic — operates on UNpremultiplied RGB per spec.
    vec3 ar = a.a > 0.0 ? a.rgb / a.a : a.rgb;
    vec3 br = b.a > 0.0 ? b.rgb / b.a : b.rgb;
    vec3 rgb = uK.x * ar * br + uK.y * ar + uK.z * br + vec3(uK.w);
    float al = uK.x * a.a * b.a + uK.y * a.a + uK.z * b.a + uK.w;
    rgb = clamp(rgb, 0.0, 1.0);
    al  = clamp(al,  0.0, 1.0);
    fragColor = vec4(rgb * al, al);
    return;
  }
  // Map feComposite op (0..4) → Porter-Duff mode (3, 5, 7, 9, 11).
  // Encoding: PD mode = 3 + 2·op.
  int pd = 3 + 2 * uOp;
  fragColor = porterDuff(pd, a, b);
}
