#version 300 es
// Fullscreen-quad pass-through for the static-scene cache blit.
// One unit quad in clip space → UV in [0,1]². Same shape as composite.vert.
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
