#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// loopBlinnComposite.vert.glsl — fullscreen-quad pass that multiplies a
// shape's paint by the Loop-Blinn coverage buffer and OVER-composites it
// onto the canvas. Pairs with loopBlinn.frag (coverage) + this composite's
// fragment. Uses the shared cover quad (clip-space [-1,1] triangle strip).
layout(location=0) in vec2 aPos;
// Coverage RTs come from the quantized pool (allocated size rounded UP to the
// pool quantum, >= viewport) with the coverage rendered into the bottom-left
// viewport-sized region. uCovScale = viewport / allocatedSize maps the
// fullscreen quad's UV into that region; sampling with a raw 0..1 UV reads
// past it (the content composites shrunk toward the origin whenever the
// canvas isn't a multiple of the pool quantum).
uniform vec2 uCovScale;
out vec2 vUv;
void main() {
  vUv = (aPos * 0.5 + 0.5) * uCovScale;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
