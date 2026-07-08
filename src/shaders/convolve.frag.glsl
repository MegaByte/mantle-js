#version 300 es
// feConvolveMatrix — general 2D convolution. Single-pass (kernel is not
// guaranteed separable, unlike Gaussian blur and feMorphology). Capped
// at 5×5 = 25 taps so the shader can unroll cleanly. Larger kernels
// from the importer are truncated; arbitrary kernel sizes need a
// dynamic loop in WebGL2 ES 3.00, which can't be unrolled.
//
// uKernelTex: RGBA32F, 7 wide × N tall. Each row holds 25 kernel
// values, packed in 7 RGBA texels (with 3 floats of padding).
// uKernelRow: which row of uKernelTex holds the current filter's
// kernel. Read order: matches kernelMatrix attribute (row-major,
// left-to-right within each row, top-to-bottom across rows).
//
// uOrder.xy = (orderX, orderY) — kernel width / height (1..5).
// uTarget.xy = (targetX, targetY) — kernel center within (orderX,orderY).
//   Default is floor((order-1)/2) but the spec allows arbitrary
//   targets — must match the importer's computation.
// uDivisor, uBias = post-multiply / add as per spec.
// uEdgeMode: 0 = duplicate (CLAMP_TO_EDGE), 1 = wrap (REPEAT),
//            2 = none (transparent black past edge).
// uPreserveAlpha: 1 → only RGB is convolved; A passes through.
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uKernelTex;
uniform vec2  uTexel;     // 1 / textureSize
uniform vec2  uOrder;     // (orderX, orderY)
uniform vec2  uTarget;    // (targetX, targetY)
uniform float uDivisor;
uniform float uBias;
uniform int   uKernelRow;
uniform int   uEdgeMode;
uniform int   uPreserveAlpha;
in vec2 vUV;
out vec4 fragColor;

// Fetch kernel[r*orderX + c] from the row-major texture packed layout.
// 7 RGBA texels per row hold 28 floats; only the first orderX*orderY
// of those are meaningful (rest are 0 from importer padding).
float kernelAt(int r, int c, int orderX) {
  int idx = r * orderX + c;
  int texel = idx / 4;
  int chan  = idx - texel * 4;
  vec4 t = texelFetch(uKernelTex, ivec2(texel, uKernelRow), 0);
  if (chan == 0) return t.x;
  if (chan == 1) return t.y;
  if (chan == 2) return t.z;
  return t.w;
}

// Sample uTex at offset, applying the edge mode. SVG's edgeMode=duplicate
// matches GL CLAMP_TO_EDGE (the default texture wrap). wrap matches
// REPEAT — but we'd need to set the texture's wrap-mode dynamically;
// instead we emulate via fract(). none is transparent-black past the
// edge.
vec4 sampleEdge(vec2 uv) {
  if (uEdgeMode == 1) {
    return texture(uTex, fract(uv));
  }
  if (uEdgeMode == 2) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
      return vec4(0.0);
    return texture(uTex, uv);
  }
  // duplicate (default) — texture is created with CLAMP_TO_EDGE so a
  // plain sample suffices.
  return texture(uTex, clamp(uv, vec2(0.0), vec2(1.0)));
}

void main() {
  int orderX = int(uOrder.x + 0.5);
  int orderY = int(uOrder.y + 0.5);
  int targetX = int(uTarget.x + 0.5);
  int targetY = int(uTarget.y + 0.5);
  vec4 acc = vec4(0.0);          // premultiplied accumulation (default path)
  vec3 accStraight = vec3(0.0);  // un-premultiplied RGB (preserveAlpha path)
  // Unrolled-friendly bounded loops: explicit max bounds 5 with break,
  // so the GLSL compiler can specialise on the constant max and bail
  // on dynamic-bounds rejection.
  for (int j = 0; j < 5; j++) {
    if (j >= orderY) break;
    for (int i = 0; i < 5; i++) {
      if (i >= orderX) break;
      // Spec: out[x,y] += kernelMatrix[orderY-j-1, orderX-i-1]
      //                    * in[x + i - targetX, y + j - targetY]
      // (Note the kernel is flipped per the SVG spec — a true
      // mathematical convolution, not a correlation.)
      float k = kernelAt(orderY - 1 - j, orderX - 1 - i, orderX);
      vec2 off = vec2(float(i - targetX), float(j - targetY)) * uTexel;
      vec4 s = sampleEdge(vUV + off);
      acc += k * s;
      accStraight += k * (s.a > 0.0 ? s.rgb / s.a : s.rgb);
    }
  }
  vec4 outc;
  if (uPreserveAlpha == 1) {
    // Per SVG spec: with preserveAlpha, the kernel applies to
    // UN-premultiplied color and the source alpha is preserved. Convolve
    // straight RGB, keep the center alpha, then re-premultiply for the
    // premultiplied filter pipeline.
    float a = texture(uTex, vUV).a;
    vec3 rgb = accStraight / max(uDivisor, 1e-6) + vec3(uBias);
    outc = vec4(rgb * a, a);
  } else {
    // Default: convolve premultiplied RGBA directly (stays premultiplied
    // if the kernel sums to 1; a non-1 kernel warps the alpha:rgb ratio).
    outc = acc / max(uDivisor, 1e-6) + vec4(uBias);
  }
  // Clamp to keep the framebuffer well-defined.
  fragColor = clamp(outc, vec4(0.0), vec4(1.0));
}
