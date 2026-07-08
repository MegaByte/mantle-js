// Shared Porter-Duff compositing math on PREMULTIPLIED RGBA (SVG feComposite
// and COLRv1 PaintComposite).
//
// Porter & Duff 1984 binary alpha compositing. Each mode is defined by
// two weight functions (Fa, Fb) over source and destination alpha:
//   Cout = Fa(Ad)·Ca + Fb(As)·Cb
//   Aout = Fa(Ad)·As + Fb(As)·Ad
// where Ca/Cb are PREMULTIPLIED RGB and As/Ad are alpha.
//
// The 12 modes (OpenType COLR PaintCompositeMode 0..11 + Plus at 12):
//   0  Clear      Fa=0       Fb=0
//   1  Src        Fa=1       Fb=0
//   2  Dst        Fa=0       Fb=1
//   3  SrcOver    Fa=1       Fb=1-As
//   4  DstOver    Fa=1-Ad    Fb=1
//   5  SrcIn      Fa=Ad      Fb=0
//   6  DstIn      Fa=0       Fb=As
//   7  SrcOut     Fa=1-Ad    Fb=0
//   8  DstOut     Fa=0       Fb=1-As
//   9  SrcAtop    Fa=Ad      Fb=1-As
//   10 DstAtop    Fa=1-Ad    Fb=As
//   11 Xor        Fa=1-Ad    Fb=1-As
//   12 Plus       Fa=1       Fb=1   (clamped to [0,1])

vec4 porterDuff(int mode, vec4 src, vec4 dst) {
  float as = src.a, ad = dst.a;
  float Fa, Fb;
  if      (mode ==  0) { Fa = 0.0;       Fb = 0.0;       }  // clear
  else if (mode ==  1) { Fa = 1.0;       Fb = 0.0;       }  // src
  else if (mode ==  2) { Fa = 0.0;       Fb = 1.0;       }  // dst
  else if (mode ==  3) { Fa = 1.0;       Fb = 1.0 - as;  }  // src over
  else if (mode ==  4) { Fa = 1.0 - ad;  Fb = 1.0;       }  // dst over
  else if (mode ==  5) { Fa = ad;        Fb = 0.0;       }  // src in
  else if (mode ==  6) { Fa = 0.0;       Fb = as;        }  // dst in
  else if (mode ==  7) { Fa = 1.0 - ad;  Fb = 0.0;       }  // src out
  else if (mode ==  8) { Fa = 0.0;       Fb = 1.0 - as;  }  // dst out
  else if (mode ==  9) { Fa = ad;        Fb = 1.0 - as;  }  // src atop
  else if (mode == 10) { Fa = 1.0 - ad;  Fb = as;        }  // dst atop
  else if (mode == 11) { Fa = 1.0 - ad;  Fb = 1.0 - as;  }  // xor
  else                 { Fa = 1.0;       Fb = 1.0;       }  // plus (12)
  vec4 outc = Fa * src + Fb * dst;
  if (mode == 12) outc = clamp(outc, vec4(0.0), vec4(1.0));
  return outc;
}
