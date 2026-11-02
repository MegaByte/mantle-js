// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
//   12 Plus       Fa=1       Fb=1   (clamped to [0,1] -- by the caller)
//
// The mode is the same for a whole pass, so it arrives as the weights' coefficients rather than as
// a number the pixel dispatches on through a 13-way chain:
//   Fa = k.x + k.y·Ad,   Fb = k.z + k.w·As
// set on the CPU by src/filterGraph/porterDuff.js. Every weight is exact in this form (0 + 0·a,
// 1 + 0·a, 0 + 1·a, 1 + -1·a), so the result is the chain's.

vec4 porterDuffK(vec4 k, vec4 src, vec4 dst) {
  float Fa = k.x + k.y * dst.a;
  float Fb = k.z + k.w * src.a;
  return Fa * src + Fb * dst;
}
