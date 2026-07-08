#version 300 es

precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform sampler2D uDst;
uniform int uMode;       
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

vec3 unpre(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : c.rgb; }

vec3 blendSeparable(int mode, vec3 src, vec3 dst) {
  if (mode == 1)  return src * dst;                              
  if (mode == 2)  return src + dst - src * dst;                  
  if (mode == 3) {                                                
    vec3 lo = 2.0 * src * dst;
    vec3 hi = 1.0 - 2.0 * (1.0 - src) * (1.0 - dst);
    return mix(lo, hi, step(0.5, dst));
  }
  if (mode == 4)  return min(src, dst);                          
  if (mode == 5)  return max(src, dst);                          
  if (mode == 6)  return mix(min(vec3(1.0), dst / max(1.0 - src, 1e-6)),
                              vec3(1.0), step(1.0, src));        
  if (mode == 7)  return mix(1.0 - min(vec3(1.0), (1.0 - dst) / max(src, 1e-6)),
                              vec3(0.0), step(src, vec3(0.0)));  
  if (mode == 8) {                                                
    vec3 lo = 2.0 * src * dst;
    vec3 hi = 1.0 - 2.0 * (1.0 - src) * (1.0 - dst);
    return mix(lo, hi, step(0.5, src));
  }
  if (mode == 9) {                                                
    vec3 d = mix(((16.0*dst - 12.0)*dst + 4.0)*dst, sqrt(dst), step(0.25, dst));
    vec3 lo = dst - (1.0 - 2.0*src) * dst * (1.0 - dst);
    vec3 hi = dst + (2.0*src - 1.0) * (d - dst);
    return mix(lo, hi, step(0.5, src));
  }
  if (mode == 10) return abs(dst - src);                         
  if (mode == 11) return src + dst - 2.0 * src * dst;            
  
  
  
  if (mode == 16) return min(src + dst, vec3(1.0));               
  if (mode == 17) return max(dst - src, vec3(0.0));               
  if (mode == 18) return vec3(1.0) - dst;                         
  return src;  
}

float lum(vec3 c) { return 0.3*c.r + 0.59*c.g + 0.11*c.b; }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0)  c = l + ((c - l) * l) / (l - n);
  if (x > 1.0)  c = l + ((c - l) * (1.0 - l)) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float cmin = min(min(c.r, c.g), c.b);
  float cmax = max(max(c.r, c.g), c.b);
  if (cmax - cmin > 0.0) return (c - cmin) * (s / (cmax - cmin));
  return vec3(0.0);
}
vec3 blendNonSeparable(int mode, vec3 src, vec3 dst) {
  if (mode == 12) return setLum(setSat(src, sat(dst)), lum(dst));  
  if (mode == 13) return setLum(setSat(dst, sat(src)), lum(dst));  
  if (mode == 14) return setLum(src, lum(dst));                    
  if (mode == 15) return setLum(dst, lum(src));                    
  return src;
}

vec3 blendDispatch(int mode, vec3 src, vec3 dst) {
  return (mode >= 12 && mode <= 15)
    ? blendNonSeparable(mode, src, dst)
    : blendSeparable(mode, src, dst);
}

int colrModeToBlend(int m) {
  
  
  if (m == 23) return 1;
  if (m >= 13 && m <= 22) return m - 11;
  if (m >= 24 && m <= 27) return m - 12;
  return 0;  
}

void main() {
  vec4 src = texture(uSrc, vUV);
  vec4 dst = texture(uDst, vUV);
  if (uMode <= 12) {
    fragColor = porterDuff(uMode, src, dst);
    return;
  }
  
  
  int bm = colrModeToBlend(uMode);
  vec3 sRgb = unpre(src);
  vec3 dRgb = unpre(dst);
  float as = src.a, ad = dst.a;
  vec3 b = blendDispatch(bm, sRgb, dRgb);
  
  vec3 outRgb = (1.0 - ad) * sRgb + ad * b;
  
  
  vec3 co = as * outRgb + ad * (1.0 - as) * dRgb;
  float finalA = as + ad - as * ad;
  fragColor = vec4(co, finalA);
}
