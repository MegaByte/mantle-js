// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _svgRef.js — GROUND TRUTH for the render smokes: the BROWSER's own SVG
// rasterizer, supersampled and box-downsampled to exact per-pixel coverage.
//
// Why this exists: no engine is fit to referee another. `aacFill: true` is
// byte-identical to Slug for circles (they route to the kind-7 SDF disc) and for
// strokes (AAC is a FILL kernel), so an AAC reference would be vacuous exactly
// where it looks strictest — and where two engines disagree, neither can say
// which is right. A reference has to come from OUTSIDE the renderer.
//
// The browser's SVG rasterizer is independent, spec-driven, and already present.
// Rasterizing at SS x and box-averaging makes the browser's own antialiasing
// irrelevant: at SS = 8 the reference is 64 samples/pixel, so its coverage is
// within ~1/128 of the analytic area regardless of how the browser antialiases.
// That is well under the 1/255 the smokes compare at.
//
// Usage (inside a smoke's page script):
//   import { svgCoverage, glCov, compare } from '/test/_svgRef.js';
//   const ref = await svgCoverage(SVG, W, H);          // top-down coverage 0..1
//   const px  = readPixelsRGBA();                      // bottom-up, as GL gives it
//   const r   = compare(ref, px, W, H, { tol: 0.02 });

// Rasterize `svg` at SS x and box-downsample to W x H.
// Returns { cov, rgba }: cov is Float32Array(W*H) alpha coverage in TOP-DOWN row
// order; rgba is Float32Array(W*H*4) of un-premultiplied color over WHITE, so it
// can be compared against a smoke's white-cleared GL readback directly.
// A percent-encoded data: URI silently fails on large documents — the browser
// just refuses to decode it and onerror fires with no detail. Ghostscript_Tiger
// (~70KB, 240 paths, and the asset that exercises the cross-boundary clip 124
// times) is large enough to hit this. A Blob URL has no practical size limit. Revoked by the caller after decode.
function svgUrl(text) {
  return URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
}

// Rasterize `svg` into a canvas of the given pixel size under an explicit viewBox.
async function raster(svg, viewBox, pxW, pxH) {
  const sized = svg
    .replace(/(<svg[^>]*?)\swidth="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\sheight="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\sviewBox="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\spreserveAspectRatio="[^"]*"/, '$1')
    .replace(
      /<svg/,
      `<svg width="${pxW}" height="${pxH}" viewBox="${viewBox}"` +
        ` preserveAspectRatio="xMidYMid meet"`,
    );
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('_svgRef: the browser refused to rasterize the SVG'));
    img.src = svgUrl(sized);
  });
  const cv = document.createElement('canvas');
  cv.width = pxW;
  cv.height = pxH;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.clearRect(0, 0, pxW, pxH);
  cx.drawImage(img, 0, 0, pxW, pxH);
  return { data: cx.getImageData(0, 0, pxW, pxH).data, w: pxW, h: pxH };
}

// The INKED extent, in user units — measured by rasterizing, not by getBBox.
//
// getBBox() returns the GEOMETRY box: it excludes stroke width, and Chrome
// silently ignores the `{stroke:true}` options object rather than honoring it,
// so a stroked path's box comes back too small and the fit lands off by half a
// stroke-width on every stroke case, identically for every engine.
// Rasterizing a generous window and finding the actual ink is exact for strokes,
// markers, filters and anything else that paints outside the geometry.
async function inkBBox(svg, W, H) {
  // FILL-only content: getBBox() is ANALYTIC and exact (Bezier extrema, not
  // samples), so use it and skip the raster entirely. The raster fallback below
  // has relative precision ~1/P, which becomes a fit error of N/P PIXELS — at
  // P=1024 and a 512px canvas that is half a pixel, and it showed up as a
  // straight-edged rect scoring 1024 bad / 0.38 max identically on all three
  // engines (the harness tell). Exact bbox, no scale sensitivity.
  //
  // Strokes still need the raster: getBBox() excludes stroke width and Chrome
  // silently ignores its {stroke:true} option.
  if (!/stroke\s*=|stroke:/.test(svg)) {
    const host = document.createElement('div');
    host.setAttribute(
      'style',
      'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden',
    );
    host.innerHTML = svg;
    document.body.appendChild(host);
    let bb = null;
    try {
      const b = host.querySelector('svg').getBBox();
      if (b && b.width > 0 && b.height > 0) bb = b;
    } catch {
      bb = null;
    } finally {
      document.body.removeChild(host);
    }
    if (bb) return { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  }
  const probeVB = /viewBox="([^"]+)"/.exec(svg);
  let [vx, vy, vw, vh] = probeVB
    ? probeVB[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [0, 0, W, H];
  if (!(vw > 0) || !(vh > 0)) {
    vx = 0;
    vy = 0;
    vw = W;
    vh = H;
  }
  // pad generously so ink that spills past the authored viewBox is still seen
  // TWO PASSES. A single coarse pass quantizes the box to its raster pitch, and
  // that error lands in the fit SCALE — which shows up as a sub-pixel offset
  // along every edge, flipping boundary pixels fully (a stroke case read as
  // max=1.00 purely from this). Pass 2 re-measures inside a tight window, so the
  // pitch is ~two orders finer than the shape.
  let box = { x: vx - vw * 0.5, y: vy - vh * 0.5, width: vw * 2, height: vh * 2 };
  const P = typeof globalThis.__REF_P === 'number' ? globalThis.__REF_P : 1024;
  for (let pass = 0; pass < 2; pass++) {
    const win = `${box.x} ${box.y} ${box.width} ${box.height}`;
    const { data } = await raster(svg, win, P, P);
    // HALF-COVERAGE CONTOUR, not "any ink". Thresholding at alpha > 2 includes
    // the antialiased skirt, so the box overshoots by ~1 raster pixel on every
    // side; that lands in the fit SCALE and shifts every edge sub-pixel (on the
    // circle case, 423 bad pixels against 149). alpha >= 128 is the geometric edge for a symmetric AA ramp, and the
    // edge sits at that pixel's CENTER, not its outer corner.
    let x0 = P,
      y0 = P,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < P; y++)
      for (let x = 0; x < P; x++) {
        if (data[(y * P + x) * 4 + 3] >= 128) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    if (x1 < 0) return { x: vx, y: vy, width: vw, height: vh };
    // the window was fitted with xMidYMid meet — recover its user-unit mapping
    const s = Math.min(P / box.width, P / box.height);
    const offX = (P - box.width * s) / 2,
      offY = (P - box.height * s) / 2;
    const toU = (cx, cy) => [(cx - offX) / s + box.x, (cy - offY) / s + box.y];
    const [ux0, uy0] = toU(x0 + 0.5, y0 + 0.5),
      [ux1, uy1] = toU(x1 + 0.5, y1 + 0.5);
    const bw = ux1 - ux0,
      bh = uy1 - uy0;
    if (!(bw > 0) || !(bh > 0)) return { x: vx, y: vy, width: vw, height: vh };
    if (pass === 1) return { x: ux0, y: uy0, width: bw, height: bh };
    // pad by a few raster pixels so pass 2 cannot clip ink at the window edge
    const pad = Math.max(bw, bh) * 0.02;
    box = { x: ux0 - pad, y: uy0 - pad, width: bw + 2 * pad, height: bh + 2 * pad };
  }
  return box;
}

export async function svgCoverage(svg, W, H, SS = 8, fitBox = null) {
  // MATCH THE RENDERER'S FIT, or the comparison is meaningless.
  //
  // The renderer does NOT map the SVG's viewBox to the viewport 1:1 — it fits the
  // CONTENT bounding box to the viewport, preserving aspect ratio and centering.
  // Verified exactly: a 96x72 rect in a 128x128 viewBox renders at scale
  // min(128/96, 128/72) = 1.333 spanning x 0..127, y 16..111. Referencing the raw
  // viewBox instead makes every shape look wrong by that fit (a circle comes out
  // 1.4x "too large").
  //
  // Reproduce it in the browser by rewriting the viewBox to the content bbox and
  // letting preserveAspectRatio="xMidYMid meet" do exactly the same fit.
  // PREFER THE RENDERER'S own BOX. getBBox() is the geometry union of every
  // element, including ones that never ink: a clip rect, a fill="none" spacer,
  // a zero-opacity guide. The importer's globalBBox counts only inked geometry,
  // so on such assets the two disagree outright and the reference is rasterized
  // at a different SCALE than the render — which reads as thousands of "wrong"
  // pixels IDENTICALLY across slug/aac/lb (the tell of a harness fault).
  //
  // Callers that can build a bundle pass its globalBBox; inkBBox stays the
  // fallback for callers that cannot.
  // Strokes included: getBBox omitting stroke width is an argument against
  // getBBox, not against globalBBox, which IS what the renderer fits. Whatever it
  // does with stroke extents, mirroring it is what makes the comparison
  // meaningful; falling back to the raster instead reintroduces its ~1/P fit error.
  const bb =
    fitBox && fitBox[2] > 0 && fitBox[3] > 0
      ? { x: fitBox[0], y: fitBox[1], width: fitBox[2], height: fitBox[3] }
      : await inkBBox(svg, W, H);

  let sized = svg
    .replace(/(<svg[^>]*?)\swidth="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\sheight="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\sviewBox="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\spreserveAspectRatio="[^"]*"/, '$1');
  // Force the raster size: an <img> without explicit width/height rasterizes at
  // the intrinsic size, so the supersample would be a plain upscale of a W x H
  // raster — a reference no better than the thing it is meant to judge.
  sized = sized.replace(
    /<svg/,
    `<svg width="${W * SS}" height="${H * SS}" viewBox="${bb.x} ${bb.y} ${bb.width} ${bb.height}"` +
      ` preserveAspectRatio="xMidYMid meet"`,
  );

  const img = new Image();
  const url = svgUrl(sized);
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () =>
      rej(
        new Error(
          '_svgRef: the browser refused to rasterize the SVG' +
            ' (viewBox=' +
            [bb.x, bb.y, bb.width, bb.height].join(' ') +
            ', ' +
            sized.length +
            ' chars) HEAD=' +
            sized.slice(0, 200),
        ),
      );
    img.src = url;
  });

  const cv = document.createElement('canvas');
  cv.width = W * SS;
  cv.height = H * SS;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.drawImage(img, 0, 0, cv.width, cv.height);
  const src = cx.getImageData(0, 0, cv.width, cv.height).data;

  const cov = new Float32Array(W * H);
  const rgba = new Float32Array(W * H * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let a = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let sy = 0; sy < SS; sy++) {
        let o = ((y * SS + sy) * cv.width + x * SS) * 4;
        for (let sx = 0; sx < SS; sx++, o += 4) {
          const av = src[o + 3] / 255;
          a += av;
          r += src[o] * av;
          g += src[o + 1] * av;
          b += src[o + 2] * av;
        }
      }
      const i = y * W + x;
      cov[i] = a * inv;
      // composite the averaged premultiplied color over WHITE, matching a smoke
      // that clears to [1,1,1,1]
      const A = a * inv;
      rgba[i * 4] = r * inv + 255 * (1 - A);
      rgba[i * 4 + 1] = g * inv + 255 * (1 - A);
      rgba[i * 4 + 2] = b * inv + 255 * (1 - A);
      rgba[i * 4 + 3] = 255;
    }
  }
  return { cov, rgba };
}

// Coverage of a white-cleared GL readback at (x, y) in TOP-DOWN coords.
// readPixels hands back bottom-up rows, which is the single most common source
// of a silently-flipped comparison.
export function glCov(px, x, y, W, H) {
  const q = ((H - 1 - y) * W + x) * 4;
  return 1 - px[q] / 255; // black-on-white ink
}

// Compare a GL readback against a reference. `tol` is per-pixel coverage.
// Returns the distribution, not just a boolean, so a smoke can assert on the
// shape of the error rather than a single count.
// COLOR comparison, the correct default. Comparing the reference's ALPHA
// coverage against the readback's darkness is only valid for a pure-black fill:
// a gradient from #000 to #999 is fully covered (alpha 1) everywhere inside
// while its ink darkness ramps 1.0 -> 0.4, so a coverage comparison reports the
// whole shape as broken — identically for every engine, which is the tell for a
// harness fault rather than an engine one.
export function compareRGB(ref, px, W, H, opts = {}) {
  const tol = opts.tol === undefined ? 0.02 : opts.tol; // in 0..1 per channel
  let bad = 0,
    sum = 0,
    max = 0,
    worst = null,
    ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x,
        q = ((H - 1 - y) * W + x) * 4;
      if (ref.cov[i] > 0.01) ink++;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(ref.rgba[i * 4 + c] - px[q + c]) / 255);
      sum += d;
      if (d > max) {
        max = d;
        worst = { x, y, ref: +(ref.rgba[i * 4] / 255).toFixed(3), got: +(px[q] / 255).toFixed(3) };
      }
      if (d > tol) bad++;
    }
  }
  return { bad, max: +max.toFixed(4), mean: +(sum / (W * H)).toFixed(5), ink, worst };
}

export function compare(ref, px, W, H, opts = {}) {
  const tol = opts.tol === undefined ? 0.02 : opts.tol;
  let bad = 0,
    sum = 0,
    max = 0,
    worst = null,
    ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = ref.cov[y * W + x],
        g = glCov(px, x, y, W, H);
      if (r > 0.01) ink++;
      const d = Math.abs(r - g);
      sum += d;
      if (d > max) {
        max = d;
        worst = { x, y, ref: +r.toFixed(3), got: +g.toFixed(3) };
      }
      if (d > tol) bad++;
    }
  }
  return { bad, max: +max.toFixed(4), mean: +(sum / (W * H)).toFixed(5), ink, worst };
}
