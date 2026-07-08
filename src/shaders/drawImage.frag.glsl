#version 300 es
// drawImage fragment — sample the source texture, apply tint + alpha.
//
// The source texture is uploaded PREMULTIPLIED (renderer.createImage),
// so the output is premultiplied and composites with the renderer's
// standard blendFunc(ONE, ONE_MINUS_SRC_ALPHA). uTint is a straight-alpha
// color multiplier ((1,1,1,1) = no tint); uAlpha is an extra 0..1 scalar.
// Both fold into the premultiplied sample by scaling all four channels by
// the tint rgb*a and the alpha, which keeps the result premultiplied.
precision highp float;

uniform sampler2D uTex;
uniform vec4  uTint;    // straight-alpha tint (r,g,b,a); (1,1,1,1)=identity
uniform float uAlpha;   // 0..1 global multiplier

in  vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 src = texture(uTex, vUV);     // premultiplied
  // Tint: multiply rgb by uTint.rgb*uTint.a and the whole texel's alpha by
  // uTint.a — this is the correct premultiplied tint (color modulates the
  // already-multiplied rgb; alpha scales coverage). uAlpha scales all four.
  float a = uTint.a * uAlpha;
  fragColor = vec4(src.rgb * uTint.rgb * a, src.a * a);
}
