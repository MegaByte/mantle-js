#version 300 es

precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() {

  if (vColor.a < 0.5 / 255.0) discard;
  fragColor = vColor;
}
