#version 300 es

precision highp float;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform int uOp;
uniform vec4 uK;          
in vec2 vUV;
out vec4 fragColor;

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
  vec4 a = texture(uIn1, vUV);
  vec4 b = texture(uIn2, vUV);
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
