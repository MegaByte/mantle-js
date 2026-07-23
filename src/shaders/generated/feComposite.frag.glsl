#version 300 es

precision highp float;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform vec4 uIn1Map;
uniform vec4 uIn2Map;
uniform int uOp;
uniform vec4 uK;
in vec2 vUV;
out vec4 fragColor;

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

vec4 porterDuff(int mode, vec4 src, vec4 dst) {
  float as = src.a, ad = dst.a;
  float Fa, Fb;
  if      (mode ==  0) { Fa = 0.0;       Fb = 0.0;       }
  else if (mode ==  1) { Fa = 1.0;       Fb = 0.0;       }
  else if (mode ==  2) { Fa = 0.0;       Fb = 1.0;       }
  else if (mode ==  3) { Fa = 1.0;       Fb = 1.0 - as;  }
  else if (mode ==  4) { Fa = 1.0 - ad;  Fb = 1.0;       }
  else if (mode ==  5) { Fa = ad;        Fb = 0.0;       }
  else if (mode ==  6) { Fa = 0.0;       Fb = as;        }
  else if (mode ==  7) { Fa = 1.0 - ad;  Fb = 0.0;       }
  else if (mode ==  8) { Fa = 0.0;       Fb = 1.0 - as;  }
  else if (mode ==  9) { Fa = ad;        Fb = 1.0 - as;  }
  else if (mode == 10) { Fa = 1.0 - ad;  Fb = as;        }
  else if (mode == 11) { Fa = 1.0 - ad;  Fb = 1.0 - as;  }
  else                 { Fa = 1.0;       Fb = 1.0;       }
  vec4 outc = Fa * src + Fb * dst;
  if (mode == 12) outc = clamp(outc, vec4(0.0), vec4(1.0));
  return outc;
}

void main() {
  vec4 a = sampleIn(uIn1, mapIn(vUV, uIn1Map));
  vec4 b = sampleIn(uIn2, mapIn(vUV, uIn2Map));
  if (uOp == 5) {

    vec3 ar = a.a > 0.0 ? a.rgb / a.a : a.rgb;
    vec3 br = b.a > 0.0 ? b.rgb / b.a : b.rgb;
    vec3 rgb = uK.x * ar * br + uK.y * ar + uK.z * br + vec3(uK.w);
    float al = uK.x * a.a * b.a + uK.y * a.a + uK.z * b.a + uK.w;
    rgb = clamp(rgb, 0.0, 1.0);
    al  = clamp(al,  0.0, 1.0);
    fragColor = vec4(rgb * al, al);
    return;
  }

  int pd = 3 + 2 * uOp;
  fragColor = porterDuff(pd, a, b);
}
