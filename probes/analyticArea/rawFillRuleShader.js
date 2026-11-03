// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// GPU experiment: native ray roots, fill rule BEFORE integration, no topology
// preparation. Scanline ordering is exact (up to root precision), with no fixed
// crossing-array capacity. Y integration is numerical: this is not a shipping
// accuracy guarantee. Compare independent references and refinement variants.
export const rawFillRuleShader = String.raw`
#ifdef MANTLE_AAC_RAW_RULE
// The same smallest covering band level as AAC. Event candidates must cover
// the cell, but do not need every segment in the path. Duplicate fine-band
// entries cannot change a minimum event (or the conservative gate).
void rawCellBands(vec2 c,vec2 px,ivec4 GD,vec4 bb,out int first,out int steps,out int stride) {
  int nb=GD.w+1;
  float hy=.5/px.y;
  int b0=clamp(int((c.y-hy-bb.y)/bandBoxSize(bb).y*float(nb)),0,nb-1);
  int b1=clamp(int((c.y+hy-bb.y)/bandBoxSize(bb).y*float(nb)),0,nb-1);
#ifdef MANTLE_AAC_PAIR_BANDS
  stride=2;
#else
  stride=1;
#endif
  first=b0;steps=(b1-b0)/stride+1;
  if(steps>2) {
    vec4 lv=bFetchL(texLin(GD.xy)+1);int top=int(lv.z),l=max(int(lv.w),1),at=int(lv.y)/2;
    for(int k=l;k<top&&(b1>>l)>(b0>>l)+1;k++) {at+=(nb+(1<<l)-1)>>l;l++;}
    if(top>0&&(b1>>l)<=(b0>>l)+1) {first=at+(b0>>l);steps=1;}
  }
}
#ifdef MANTLE_RAW_RULE_GATE
// For a polygon cell touching at most one boundary segment, winding has only
// two consecutive integer values: the ordinary AAC fold is linear and exact.
// Two bbox hits conservatively route to fill-rule-before-area integration.
// Counts may contain band duplicates, making the gate more conservative.
bool rawNeedsRule(vec2 c,vec2 px,ivec4 GD,vec4 bb) {
  int first,steps,stride,hits=0;rawCellBands(c,px,GD,bb,first,steps,stride);
  vec2 lo=c-.5/px,hi=c+.5/px;
  for(int b=0;b<steps;b++) {
    int hdr=texLin(GD.xy)+2*(first+b*stride),n=int(bFetchL(hdr).x);
    int at=texLin(GD.xy)+int(bFetchL(hdr+1).x);
    for(int i=0;i<n;i++) {
      vec4 e=bFetchL(at+i);if(e.y<lo.x)break;
      vec4 p=cFetchL(int(e.x)+1);
      if(max(p.x,p.z)>=lo.x&&min(p.x,p.z)<=hi.x&&max(p.y,p.w)>=lo.y&&min(p.y,p.w)<=hi.y) {
        if(++hits>=2)return true;
      }
    }
  }
  return false;
}
#endif
void rawTake(float x, float sg, float cursor, inout float next, inout float jump, inout float wr) {
  if (isnan(x) || isinf(x)) return;
  if (x >= 1.0) wr += sg;
  if (x <= 0.0 || x >= cursor) return;
  if (x > next) { next = x; jump = sg; }
  else if (x == next) jump += sg;
}
// Largest crossing below cursor, all tied crossings as one jump. No fixed
// root-list capacity; the count in the real band bounds the traversal.
void rawStep(vec2 c, vec2 px, ivec4 GD, vec4 bb, float cursor,
             out float next, out float jump, out float wr, out int cap) {
  next = 0.0; jump = 0.0; wr = 0.0;
  int by = clamp(int((c.y - bb.y) / bandBoxSize(bb).y * float(GD.w + 1)), 0, GD.w);
  int hdr = texLin(GD.xy) + by * 2;
  ivec4 ns = ivec4(bFetchL(hdr));
  int at = texLin(GD.xy) + int(bFetchL(hdr + 1).x);
  cap = ns.x + 2 * ns.y + 3 * (ns.z + ns.w);
#ifndef MANTLE_NO_LINE
  for (int i=0;i<ns.x;i++) {
    vec4 p = cFetchL(int(bFetchL(at+i).x)+1) - vec4(c,c);
    if ((p.y < 0.0) == (p.w < 0.0)) continue;
    float t = -p.y / (p.w-p.y);
    rawTake(mix(p.x,p.z,t)*px.x+0.5, p.w>p.y?1.0:-1.0, cursor,next,jump,wr);
  }
#endif
  at += ns.x;
#if !defined(MANTLE_NO_QUAD) && !defined(MANTLE_RAW_RULE_LINES)
  for (int i=0;i<ns.y;i++) {
    int s = int(bFetchL(at+i).x);
    vec4 p = cFetchL(s+1)-vec4(c,c); vec2 q = cFetchL(s+2).xy-c;
    uint code = calcRootCode2(p.y,p.w,q.y);
    if (code == 0u) continue;
    vec4 r = slugSolveHorizQuad(p,q);
    if ((code&1u)!=0u) rawTake(r.x*px.x+0.5,-1.0,cursor,next,jump,wr);
    if (code>1u) rawTake(r.y*px.x+0.5,1.0,cursor,next,jump,wr);
  }
#endif
  at += ns.y;
#if !defined(MANTLE_NO_CUBIC) && !defined(MANTLE_RAW_RULE_LINES)
  for (int i=0;i<ns.z;i++) {
    int s = int(bFetchL(at+i).x);
    vec4 p = cFetchL(s+1)-vec4(c,c), q = cFetchL(s+2)-vec4(c,c);
    vec3 rs,ts,up; solveCubicBisect(p,q,false,rs,ts,up);
    for (int j=0;j<3;j++) if (ts[j]>=0.0)
      rawTake(rs[j]*px.x+0.5,up[j]>.5?1.0:-1.0,cursor,next,jump,wr);
  }
#endif
  at += ns.z;
#if !defined(MANTLE_NO_ARC) && !defined(MANTLE_RAW_RULE_LINES)
  for (int i=0;i<ns.w;i++) {
    int s = int(bFetchL(at+i).x);
    vec4 d1 = cFetchL(s+1), d2 = cFetchL(s+2), ends = cFetchL(s+3);
    float sp = sin(d2.z), cp = cos(d2.z); vec3 sw = arcSweep(d2);
    vec2 lo,hi; arcEndsLoHi(ends,sw.z,lo,hi);
    vec4 pc;vec3 ax;
    vec3 cr = arcRayCrossings(sw.x,sw.y,sw.z,sp*d1.z,cp*d1.w,-(d1.y-c.y),lo.y-c.y,hi.y-c.y,false,pc,ax);
    vec3 ts = arcRayRoots(sw.x,sw.y,sp*d1.z,cp*d1.w,-(d1.y-c.y),pc,ax);
    for (int j=0;j<3;j++) if (cr[j]!=0.0) {
      vec2 p;float dx,dy;arcSample(d1,cp,sp,ts[j],p,dx,dy);
      rawTake((p.x-c.x)*px.x+.5,cr[j]>1.5?-1.0:1.0,cursor,next,jump,wr);
    }
  }
#endif
}
float rawInside(float w, bool eo) {
  return eo ? mod(abs(w),2.0) : (w!=0.0?1.0:0.0);
}
float rawWidth(vec2 c, vec2 px, ivec4 GD, bool eo, vec4 bb) {
  float cursor=1.0,w=0.0,area=0.0,next,jump,wr;int cap;
  rawStep(c,px,GD,bb,cursor,next,jump,wr,cap);w=wr;
  for (int k=0;k<=cap;k++) {
    area += (cursor-next)*rawInside(w,eo);
    if (next==0.0) break;
    cursor=next;w+=jump;
    rawStep(c,px,GD,bb,cursor,next,jump,wr,cap);
  }
  return area;
}
void rawEvent(float y, float cursor, inout float next) {
  if (y>cursor && y<next) next=y;
}
float rawEval(vec4 C,float t) {return ((C.x*t+C.y)*t+C.z)*t+C.w;}
// Include segment endpoints and extrema so a subpixel component cannot fall
// entirely between integration nodes merely because the whole cell was sampled.
float rawNextEvent(vec2 c,vec2 px,ivec4 GD,vec4 bb,float cursor) {
  int first,steps,stride;rawCellBands(c,px,GD,bb,first,steps,stride);
  float next=1.0;
  for (int b=0;b<steps;b++) {
    int hdr=texLin(GD.xy)+2*(first+b*stride);ivec4 ns=ivec4(bFetchL(hdr));
    int at=texLin(GD.xy)+int(bFetchL(hdr+1).x);
  #ifdef MANTLE_RAW_RULE_LINES
    int total=ns.x;
#else
    int total=ns.x+ns.y+ns.z+ns.w;
#endif
    for (int i=0;i<total;i++) {
      vec4 e=bFetchL(at+i);int s=int(e.x);
      vec4 p=cFetchL(s+1);
#ifdef MANTLE_RAW_RULE_LINES
      vec2 cellLo=c-.5/px,cellHi=c+.5/px;
      if(e.y<cellLo.x)break;
      if(min(p.x,p.z)>cellHi.x||max(p.y,p.w)<cellLo.y||min(p.y,p.w)>cellHi.y)continue;
#else
      rawEvent((e.z-c.y)*px.y+.5,cursor,next);
      rawEvent((e.w-c.y)*px.y+.5,cursor,next);
#endif
      if (i<ns.x) {
#ifdef MANTLE_RAW_RULE_LINES
        vec2 A=p.xy-c, V=p.zw-p.xy;
        for(int wall=0;wall<2;wall++) if(V.x!=0.0) {
          float t=((float(wall)-.5)/px.x-A.x)/V.x;
          if(t>0.0&&t<1.0)rawEvent((A.y+t*V.y)*px.y+.5,cursor,next);
        }
        // The line width changes slope/order only at a vertex, a pixel wall,
        // or a pair intersection. Between these events, midpoint is EXACT.
        for(int j=i+1;j<ns.x;j++) {
          vec4 q=cFetchL(int(bFetchL(at+j).x)+1);
          if(max(q.x,q.z)<cellLo.x||min(q.x,q.z)>cellHi.x||max(q.y,q.w)<cellLo.y||min(q.y,q.w)>cellHi.y)continue;
          vec2 B=q.xy-c,W=q.zw-q.xy,D=B-A;
          float det=V.x*W.y-V.y*W.x;
          if(det==0.0)continue;
          float t=(D.x*W.y-D.y*W.x)/det,u=(D.x*V.y-D.y*V.x)/det;
          if(t>0.0&&t<1.0&&u>0.0&&u<1.0) rawEvent((A.y+t*V.y)*px.y+.5,cursor,next);
        }
#endif
        rawEvent((p.y-c.y)*px.y+.5,cursor,next);rawEvent((p.w-c.y)*px.y+.5,cursor,next);
      }
#ifndef MANTLE_RAW_RULE_LINES
      else if (i<ns.x+ns.y+ns.z) {
        vec4 q=cFetchL(s+2);
        vec4 Y=i<ns.x+ns.y ? aacQuadCoeff(p.y-c.y,p.w-c.y,q.y-c.y)
                                        : aacCubicCoeff(p.y-c.y,p.w-c.y,q.y-c.y,q.w-c.y);
        rawEvent(Y.w*px.y+.5,cursor,next);
        rawEvent(rawEval(Y,1.0)*px.y+.5,cursor,next);
        vec2 r=aacQuadRoots(3.0*Y.x,2.0*Y.y,Y.z);
        for (int j=0;j<2;j++) if (r[j]>0.0&&r[j]<1.0) rawEvent(rawEval(Y,r[j])*px.y+.5,cursor,next);
      } else {
        vec4 q=cFetchL(s+3);rawEvent((q.y-c.y)*px.y+.5,cursor,next);rawEvent((q.w-c.y)*px.y+.5,cursor,next);
      }
#endif
    }
  }
  return next;
}
float rawIntegrate(vec2 c,vec2 px,ivec4 GD,bool eo,vec4 bb,float a,float b) {
#ifdef MANTLE_RAW_RULE_LINES
  return (b-a)*rawWidth(vec2(c.x,c.y+((a+b)*.5-.5)/px.y),px,GD,eo,bb);
#else
  // 8-point Gauss-Legendre per subinterval. Two refinement defines make the
  // numerical error measurable without changing the ray/fill-rule algorithm.
#ifdef MANTLE_RAW_RULE_FINE
  const int pieces=8;
#elif defined(MANTLE_RAW_RULE_MEDIUM)
  const int pieces=4;
#else
  const int pieces=2;
#endif
  float area=0.0;
  for(int k=0;k<pieces;k++) {
    float h=(b-a)/(2.0*float(pieces)), m=a+(float(k)+.5)*(b-a)/float(pieces);
    for(int j=0;j<4;j++) {
      float x=j==0?.1834346425:j==1?.5255324099:j==2?.7966664774:.9602898565;
      float w=j==0?.3626837834:j==1?.3137066459:j==2?.2223810345:.1012285363;
      for(int sg=-1;sg<=1;sg+=2) {
        float y=m+float(sg)*h*x;
        area+=h*w*rawWidth(vec2(c.x,c.y+(y-.5)/px.y),px,GD,eo,bb);
      }
    }
  }
  return area;
#endif
}
float rawFillRule(vec2 c,vec2 px,ivec4 GD,bool eo,vec4 bb) {
  vec2 halfPixel=.5/px;
  if(c.x+halfPixel.x<=bb.x||c.x-halfPixel.x>=bb.z) return 0.0;
  float y=clamp((bb.y-c.y)*px.y+.5,0.0,1.0),end=clamp((bb.w-c.y)*px.y+.5,0.0,1.0),area=0.0;
  // Every trip advances to a distinct float event. No event-count cap that can
  // silently drop the rest of a shape.
  while(y<end) {
    float next=min(end,rawNextEvent(c,px,GD,bb,y));
    if (!(next>y)) break;
    area+=rawIntegrate(c,px,GD,eo,bb,y,next);y=next;
  }
  return clamp(area,0.0,1.0);
}
#endif
`;
export function addRawFillRuleVariant(shaders) {
  for (const k of Object.keys(shaders)) {
    const needle = 'float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {';
    shaders[k] = shaders[k].replace(
      needle,
      rawFillRuleShader +
        '\n' +
        needle +
        String.raw`
#ifdef MANTLE_RAW_RULE_INLINE_GATE
  g_rawHits=0;
#elif defined(MANTLE_AAC_RAW_RULE)
#ifdef MANTLE_RAW_RULE_GATE
  if(rawNeedsRule(c,px,GD,shapeBB))
#endif
  return rawFillRule(c,px,GD,evenOdd,shapeBB);
#endif`,
    );
    const walk =
      'float aacWalkBand(ivec2 gl, int bandY, vec2 c, vec2 px, float xBreak, float q0, float q1) {';
    shaders[k] = shaders[k].replace(
      walk,
      '#ifdef MANTLE_RAW_RULE_INLINE_GATE\nint g_rawHits=0;\n#endif\n' + walk,
    );
    const line = '    run += aacLineContrib(aacPL(pe.xy, c, px), aacPL(pe.zw, c, px), q0, q1);';
    shaders[k] = shaders[k].replace(
      line,
      String.raw`
#ifdef MANTLE_RAW_RULE_INLINE_GATE
    vec2 lo=c-.5/px,hi=c+.5/px;
    if(g_rawHits<2 && max(pe.x,pe.z)>=lo.x && min(pe.x,pe.z)<=hi.x && max(pe.y,pe.w)>=lo.y && min(pe.y,pe.w)<=hi.y)g_rawHits++;
#endif
` + line,
    );
    // The unique AAC diagonal return; its rotated counterpart stays untouched.
    const start = shaders[k].indexOf(needle),
      end = shaders[k].indexOf('  return aacFold(run, evenOdd);', start);
    if (end >= 0)
      shaders[k] =
        shaders[k].slice(0, end) +
        String.raw`
#ifdef MANTLE_RAW_RULE_INLINE_GATE
  if(g_rawHits>=2)return rawFillRule(c,px,GD,evenOdd,shapeBB);
#endif
` +
        shaders[k].slice(end);
  }
  return shaders;
}
