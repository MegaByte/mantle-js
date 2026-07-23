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

// Per-draw color matrix recolor, same algebra and the same per-draw uniform
// branch as the vector path (src/shaders/mantle.frag.glsl):
//   out.rgba = uColorMatrix * in.rgba + uColorMatrixOffset
// applied to STRAIGHT color, before the tint/alpha premultiply — so a matrix
// that recolors a vector fill recolors a raster blit identically.
uniform mat4 uColorMatrix;
uniform vec4 uColorMatrixOffset;
uniform int  uColorMatrixEnabled;

in  vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 src = texture(uTex, vUV);     // premultiplied
  if (uColorMatrixEnabled != 0) {
    // The texture is premultiplied but the matrix is defined on straight
    // color; unpremultiply, recolor, then re-premultiply.
    vec4 c = vec4(src.a > 0.0 ? src.rgb / src.a : vec3(0.0), src.a);
    c = clamp(uColorMatrix * c + uColorMatrixOffset, 0.0, 1.0);
    src = vec4(c.rgb * c.a, c.a);
  }
  // Tint: multiply rgb by uTint.rgb*uTint.a and the whole texel's alpha by
  // uTint.a — this is the correct premultiplied tint (color modulates the
  // already-multiplied rgb; alpha scales coverage). uAlpha scales all four.
  float a = uTint.a * uAlpha;
  fragColor = vec4(src.rgb * uTint.rgb * a, src.a * a);
}
