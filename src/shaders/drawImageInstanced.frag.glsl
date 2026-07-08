#version 300 es
// drawImageInstanced fragment — sample the shared source texture, apply the
// PER-INSTANCE tint+alpha that the vertex stage folded into vTint.
//
// The source texture is premultiplied (renderer.createImage), so output is
// premultiplied and composites with blendFunc(ONE, ONE_MINUS_SRC_ALPHA).
// vTint carries (tint.rgb, tint.a*alpha) per instance — same convention as
// drawImage's uTint*uAlpha, precombined: rgb multiplies the premultiplied
// texel, and vTint.a scales overall coverage.
precision highp float;

uniform sampler2D uTex;

in  vec2 vUV;
in  vec4 vTint;     // (r, g, b, a) — a already folds tint.a * alpha
out vec4 fragColor;

void main() {
  vec4 src = texture(uTex, vUV);          // premultiplied
  float a = vTint.a;
  fragColor = vec4(src.rgb * vTint.rgb * a, src.a * a);
}
