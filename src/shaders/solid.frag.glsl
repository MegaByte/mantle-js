#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
precision highp float;
uniform vec4 uFillColor;
out vec4 fragColor;
void main() { fragColor = uFillColor; }
