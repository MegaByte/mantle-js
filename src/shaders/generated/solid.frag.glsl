#version 300 es

precision highp float;
uniform vec4 uFillColor;
out vec4 fragColor;
void main() { fragColor = uFillColor; }
