#version 300 es
// loopBlinnComposite.vert.glsl — fullscreen-quad pass that multiplies a
// shape's paint by the Loop-Blinn coverage buffer and OVER-composites it
// onto the canvas. Pairs with loopBlinn.frag (coverage) + this composite's
// fragment. Uses the shared cover quad (clip-space [-1,1] triangle strip).
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
