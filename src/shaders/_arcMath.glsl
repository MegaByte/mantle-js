// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _arcMath.glsl — the exact distance from a point to an elliptical ARC, and the pieces it needs.
//
// Shared because two paths need the same answer: the band walk (spliced via @@COVERAGE@@) and the
// split-stroke pass (via @@STROKE_MATH@@), which are otherwise disjoint — no shader includes both,
// so these definitions cannot collide. Kept inside _coverage.glsl, the stroke pass could not reach
// them and would have to take arcs as CUBICS instead: an approximation, since a circular arc has no
// cubic form (8.9e-3 of the radius on a 90-degree sweep).
//
// distToEllipse is the exact foot-of-perpendicular, not the |f|/|grad f| first-order estimate that
// preceded it — that one is right for a circle and facets thick strokes on any true ellipse.


// Exact axis values avoid ANGLE/Metal's sign reversal for atan(y, -0.0).
// No epsilon: every nonzero x keeps the driver's existing angle and branch cut.
float curveAtan2(float y, float x) {
  return x == 0.0 ? sign(y) * 1.5707963267948966 : atan(y, x);
}

vec2 evalArc(float cx, float cy, float rx, float ry, float phi, float th) {
  float ct=cos(th), st=sin(th), cp=cos(phi), sp=sin(phi);
  return vec2(cx+cp*rx*ct-sp*ry*st, cy+sp*rx*ct+cp*ry*st);
}
float arcDyDtheta(float rx, float ry, float phi, float th) {
  float ct = cos(th), st = sin(th), cp = cos(phi), sp = sin(phi);
  return -sp * rx * st + cp * ry * ct;
}
float arcDxDtheta(float rx, float ry, float phi, float th) {
  float ct = cos(th), st = sin(th), cp = cos(phi), sp = sin(phi);
  return -cp * rx * st - sp * ry * ct;
}
const float TWO_PI = 6.28318530717958647692;
float hlslFmod(float x, float m) { return x - m * trunc(x / m); }

///
vec2 ellipseFootNearCircle(vec2 ab, vec2 p) {
  bool xMajor = ab.x >= ab.y;
  float e0 = xMajor ? ab.x : ab.y, e1 = xMajor ? ab.y : ab.x;
  float y0 = xMajor ? p.x : p.y, y1 = xMajor ? p.y : p.x;
  float x0, x1;
  if (y1 > 0.0) {
    if (y0 > 0.0) {
      // In u = (t + e1^2) / e1^2 -- Eberly's s + 1, taken as the variable itself, because near the center s is near -1
      // and s + 1 kept only ulp(1) / u of its digits (5e-5 r at 1e-3 r from the center). z_i = y_i / e_i and
      // d = (e0 / e1)^2 - 1 formed as (e0 - e1)(e0 + e1) / e1^2, exactly enough that it is NOT a rounding of 1:
      //   G(u) = ((1 + d) z0 / (u + d))^2 + (z1 / u)^2 - 1, decreasing, its root in [z1, max(1, |((1 + d) z0, z1)|)].
      float z0 = y0 / e0, z1 = y1 / e1, g = z0 * z0 + z1 * z1 - 1.0;
      if (g != 0.0) {
        float d = (e0 - e1) * (e0 + e1) / (e1 * e1), n0 = z0 + d * z0;
        float u0 = z1, u1 = g < 0.0 ? 1.0 : length(vec2(n0, z1));
        // Inside the evolute the root can be arbitrarily close to z1.
        // Start there instead of halving a unit bracket a fixed number of times.
        float u = n0 < d ? u0 : u1;
        for (int i = 0; i < 64; i++) {
          float q0 = n0 / (u + d), q1 = z1 / u;
          float gs = q0 * q0 + q1 * q1 - 1.0;
          if (gs > 0.0) u0 = u; else if (gs < 0.0) u1 = u; else break;
          // Scale the derivative by u to avoid overflow near the center.
          float next = u + u * gs / (2.0 * (q0 * q0 * u / (u + d) + q1 * q1));
          if (next == u) break;
          if (!(next > u0 && next < u1)) next = .5 * (u0 + u1);
          if (next == u || next == u0 || next == u1) break;
          u = next;
        }
        x0 = (y0 + d * y0) / (u + d); x1 = y1 / u;
      } else { x0 = y0; x1 = y1; }                        // on the ellipse
    } else { x0 = 0.0; x1 = e1; }                         // on the minor axis
  } else {                                                // on the major axis: inside its evolute, or its vertex
    float num = e0 * y0, den = (e0 - e1) * (e0 + e1);
    if (num < den) { float xd = num / den; x0 = e0 * xd; x1 = e1 * sqrt(max(1.0 - xd * xd, 0.0)); }
    else { x0 = e0; x1 = 0.0; }
  }
  return xMajor ? vec2(x0, x1) : vec2(x1, x0);
}

float distToEllipse(vec2 ab, vec2 pIn, out vec2 foot) {
  // A ZERO COORDINATE TAKES +, not sign()'s 0: a foot is a point of the ellipse, and 0 * foot put the CENTER's
  // foot at the center -- distance 0, the stroke drawn through the middle of a circle at its exact center pixel -- and
  // put a point on the major axis inside the evolute, whose foot is off the axis, back on it.
  vec2 sgn = vec2(pIn.x < 0.0 ? -1.0 : 1.0, pIn.y < 0.0 ? -1.0 : 1.0);
  vec2 p = abs(pIn);
  bool swap = p.x > p.y;
  if (swap) { p = p.yx; ab = ab.yx; }
  float l = ab.y * ab.y - ab.x * ab.x;
  // A circle is a circle when float32 says so: its squared radii are the same float. A relative tolerance below
  // float32's resolution would send radii ONE ulp apart into the ellipse solve below, which divides by l and returns
  // NaN for them. Radii within 2^-6 (2^17 ulps) of each other take the near-circle foot, which is exact there; the
  // closed form runs only where it is (see ellipseFootNearCircle).
  if (l == 0.0) {                                         // a circle → trivial closest point
    // The direction of p, normalized in its own units: p / max(p) is scale-free, so its square never underflows (unlike
    // normalize(p + 1e-20), whose squares go subnormal under 1e-19 -- taking the foot off the circle -- and which at
    // p = 0 is 0/0 on a GPU that flushes them). At the center every point of the circle is the foot.
    float pm = max(p.x, p.y);
    vec2 fq = pm > 0.0 ? ab.x * normalize(p / pm) : vec2(ab.x, 0.0);
    vec2 fo = swap ? fq.yx : fq.xy;
    foot = sgn * fo;
    return length(pIn - foot);
  }
  if (abs(ab.y - ab.x) < (1.0 / 64.0) * max(ab.x, ab.y)) {
    vec2 fq = ellipseFootNearCircle(ab, p);
    vec2 fo = swap ? fq.yx : fq.xy;
    foot = sgn * fo;
    return length(pIn - foot);
  }
  float m = ab.x * p.x / l; float m2 = m * m;
  float n = ab.y * p.y / l; float n2 = n * n;
  float c = (m2 + n2 - 1.0) / 3.0; float c3 = c * c * c;
  float q = c3 + m2 * n2 * 2.0;
  float d = c3 + m2 * n2;
  float g = m + m * n2;
  float co;
  if (d < 0.0) {
    float h = acos(clamp(q / c3, -1.0, 1.0)) / 3.0;
    float s = cos(h);
    float t = sin(h) * sqrt(3.0);
    float rx = sqrt(max(-c * (s + t + 2.0) + m2, 0.0));
    float ry = sqrt(max(-c * (s - t + 2.0) + m2, 0.0));
    co = (ry + sign(l) * rx + abs(g) / (rx * ry + 1e-20) - m) / 2.0;
  } else {
    float h = 2.0 * m * n * sqrt(d);
    float s = sign(q + h) * pow(abs(q + h), 1.0 / 3.0);
    float u = sign(q - h) * pow(abs(q - h), 1.0 / 3.0);
    float rx = -s - u - c * 4.0 + 2.0 * m2;
    float ry = (s - u) * sqrt(3.0);
    float rm = sqrt(rx * rx + ry * ry);
    co = (ry / sqrt(max(rm - rx, 1e-20)) + 2.0 * g / (rm + 1e-20) - m) / 2.0;
  }
  co = clamp(co, 0.0, 1.0);
  vec2 fq = vec2(ab.x * co, ab.y * sqrt(max(1.0 - co * co, 0.0)));
  vec2 fo = swap ? fq.yx : fq.xy;             // undo axis swap
  foot = sgn * fo;                            // restore quadrant
  return length(pIn - foot);
}

bool arcInRange(float t, float tS, float tE) {
  if (abs(tE - tS) >= TWO_PI) return true;
  float dur = tE - tS;
  float d = hlslFmod(t - tS, TWO_PI);
  if (d < 0.0) d += TWO_PI;
  if (dur > 0.0) return d < dur;
  if (d > 0.0) d -= TWO_PI;
  return d > dur;
}

// THE FOOT'S ECCENTRIC ANGLE, and whether the arc [tS, tE] reaches it. `foot` is a point of the ellipse (distToEllipse's)
// in its own frame, so (cos, sin) = (foot.x / rx, foot.y / ry) -- which atan takes scaled by rx * ry, with no divide (a
// floored divide took a tiny arc's angle against radii it does not have). A ZERO RADIUS makes that atan(0, 0),
// which GLSL leaves undefined: a NaN on a strict driver, and 0 or pi under libm, neither of them the foot's.
// The ellipse is then a segment along its other axis, traced out and back, and each of its points is TWO angles,
// mirror images across that axis: the angle is the one the arc reaches (the first, where it reaches both). Both radii
// zero, the ellipse is its center, which every angle of the arc is.
float arcFootAngle(vec2 radii, vec2 foot, float tS, float tE, out bool inRange) {
  if (radii.x != 0.0 && radii.y != 0.0) {
    // atan(y, x) AT x = +-0 IS NOT SAFE ON A GPU: distToEllipse's foot takes its sign from the point (sgn * fo), and a foot on the
    // ellipse's minor axis is fo.x = 0 -- so -0.0 for a point a hair left of the axis. A GLSL/Metal atan2 that divides (y / x) reads
    // y / -0.0 as +infinity and answers +pi/2 for a foot at -pi/2: the foot lands on the far side of the sweep, `inRange` is false, the
    // arc's body is lost and the fragment takes the endpoint distance, one pixel a stroke wide
    // inside its body left blank). The angle of a point ON the y axis is exactly +-pi/2 by the sign of y -- read without atan, scale
    // free (no epsilon): only the zero test is new.
    float fx = foot.x * radii.y, fy = foot.y * radii.x;
    float t = fx == 0.0 ? (fy == 0.0 ? 0.0 : (fy < 0.0 ? -0.25 * TWO_PI : 0.25 * TWO_PI)) : atan(fy, fx);
    inRange = arcInRange(t, tS, tE);
    return t;
  }
  if (radii.x == 0.0 && radii.y == 0.0) { inRange = true; return tS; }
  float a = radii.x != 0.0 ? acos(clamp(foot.x / radii.x, -1.0, 1.0)) : asin(clamp(foot.y / radii.y, -1.0, 1.0));
  float b = radii.x != 0.0 ? -a : 0.5 * TWO_PI - a;
  bool ia = arcInRange(a, tS, tE);
  inRange = ia || arcInRange(b, tS, tE);
  return ia ? a : b;
}

// A restricted ellipse can admit its second local minimum while excluding
// the global foot. Only points inside the evolute have two local minima.
// In major/minor coordinates, A=|px|/delta and B=b|py|/delta give
// G(v)=A²/(1-v)²+B²/v²-1. The secondary minimum is the unique root
// between B and B^(2/3)/(A^(2/3)+B^(2/3)); maxima cannot beat arc ends.
float arcClosestFoot(vec2 radii, vec2 p, float tS, float tE,
                     out vec2 foot, out float angle, out bool inRange) {
  float distance = distToEllipse(radii, p, foot);
  angle = arcFootAngle(radii, foot, tS, tE, inRange);
  if (inRange || min(radii.x, radii.y) == 0.0 || radii.x == radii.y) return distance;
  bool swapAxes = radii.x < radii.y;
  float scale = max(radii.x, radii.y), b = min(radii.x, radii.y) / scale;
  vec2 q = (swapAxes ? p.yx : p) / scale;
  float delta = (1.0 - b) * (1.0 + b);
  float A = abs(q.x) / delta, B = b * abs(q.y) / delta;
  if (A >= 1.0 || B >= 1.0) return distance;
  vec2 candidate;
  if (B == 0.0) {
    candidate = vec2(A * (q.x < 0.0 ? -1.0 : 1.0), -b * sqrt(max(0.0, 1.0 - A * A)));
  } else if (A == 0.0) {
    candidate = vec2(0.0, q.y < 0.0 ? b : -b);
  } else {
    float a23 = pow(A, 2.0 / 3.0), b23 = pow(B, 2.0 / 3.0);
    if (a23 + b23 >= 1.0) return distance;
    float lo = B, hi = b23 / (a23 + b23), v = lo;
    for (int i = 0; i < 32; i++) {
      float x = A / (1.0 - v), y = B / v;
      float f = x * x + y * y - 1.0;
      if (f == 0.0) break;
      if (f > 0.0) lo = v; else hi = v;
      float derivative = 2.0 * (x * x / (1.0 - v) - y * y / v);
      float next = v - f / derivative;
      if (next == v) break;
      if (!(next > lo && next < hi)) next = .5 * (lo + hi);
      if (next == v || next == lo || next == hi) break;
      v = next;
    }
    candidate = vec2(A / (1.0 - v) * (q.x < 0.0 ? -1.0 : 1.0),
      -b * B / v * (q.y < 0.0 ? -1.0 : 1.0));
  }
  candidate = (swapAxes ? candidate.yx : candidate) * scale;
  bool candidateInRange;
  float candidateAngle = arcFootAngle(radii, candidate, tS, tE, candidateInRange);
  if (candidateInRange) {
    foot = candidate; angle = candidateAngle; inRange = true;
    return length(p - candidate);
  }
  return distance;
}

// GL-16 arc length of an elliptical arc over [0,t] of its sweep. d1=(cx,cy,
// rx,ry), d2=(th0,th1,phi). |dp/dθ| = √(rx²sin²θ+ry²cos²θ) (rotation by phi
// preserves length); same nodes/weights/integrand as the encoder and the hit
// test, so dashed native arcs (circles/ellipses) phase continuously.
float arcArcLen(vec4 d1, vec4 d2, float t) {
  float dth = d2.y - d2.x;
  // A CIRCLE's integrand is the constant radius and the weights sum to 1, so the rule is exact in
  // closed form: 16 sin, cos and sqrt fewer per dashed circular arc (rounded-rect corners, SVG arc
  // commands, dashed circles -- which miss the annulus fast path). Exact equality: the encoder writes
  // a circle's two radii as one value, and a near-circle keeps the rule.
  if (d1.z == d1.w) return t * abs(dth) * abs(d1.z);
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    float th = d2.x + dth * (t * SLUG_GL16_N[i]);
    float st = sin(th), ct = cos(th);
    sum += SLUG_GL16_W[i] * sqrt(d1.z * d1.z * st * st + d1.w * d1.w * ct * ct);
  }
  return t * abs(dth) * sum;
}
