// svg/image.js — <image> href decoding + per-document preload.
//
// Async because in-browser the only way to rasterise an <image> href is
// via the <img>+<canvas> pair (no synchronous browser API exists).
// Node / xmldom contexts without a DOM canvas return null (the caller
// skips the image — graceful degradation).
//
// SVG-content hrefs (data:image/svg+xml,... and *.svg / *.svgz URLs)
// route to a separate path that returns { isSvg: true, svgText, viewBox }
// — the importer walks this recursively, mapping the nested viewBox into
// the outer <image>'s rect, instead of rasterising.

import { elementChildren } from './utils.js';
// Gzip decode lives in core/gzip.js (shared with the SVG-in-OT path).
// Re-exported here for callers importing gunzipBytes from this module.
import { gunzipBytes } from '../core/gzip.js';
export { gunzipBytes };

/// True if href looks like SVG content: data URL with image/svg+xml
/// MIME, or a URL whose path ends in .svg / .svgz.
export function isSvgHref(href) {
  if (!href) return false;
  const lo = href.trim().toLowerCase();
  if (lo.startsWith('data:image/svg+xml')) return true;
  // Strip query/fragment, then check extension.
  const noQ = lo.replace(/[?#].*$/, '');
  return noQ.endsWith('.svg') || noQ.endsWith('.svgz');
}


/// True iff the bytes start with the gzip magic (0x1f 0x8b). Helpful
/// when a fetch returned bytes that may or may not be compressed
/// (some servers serve .svgz with Content-Encoding: gzip already
/// decoded; others don't).
export function isGzipped(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/// Convenience: fetch + decompress *.svgz to SVG text. Use this as
/// the svgTextLoader (or a piece of it) when the URL ends in .svgz
/// or you suspect gzip content.
export async function decodeSvgzBytes(bytes) {
  const decompressed = isGzipped(bytes) ? await gunzipBytes(bytes) : bytes;
  return new TextDecoder('utf-8').decode(decompressed);
}

/// Extract the SVG text from a data URL whose MIME is image/svg+xml.
/// Supports both base64 and percent-encoded payloads. Returns null on
/// parse failure.
export function decodeSvgDataUrl(href) {
  if (!href) return null;
  const m = /^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(href.trim());
  if (!m) return null;
  const isB64 = !!m[1];
  let body = m[2];
  if (isB64) {
    try {
      if (typeof atob === 'function') return atob(body);
      // Node fallback.
      return Buffer.from(body, 'base64').toString('utf8');
    } catch (e) { return null; }
  }
  try { return decodeURIComponent(body); }
  catch (e) { return null; }
}

/// Decode an <image>'s href. Returns one of:
///   { isSvg: true, svgText }      — SVG content (data URL or
///                                   svgTextLoader-resolved URL)
///   { w, h, rgba }                — raster bitmap
///   null                          — fetch/decoder failure
///
/// `opts.svgTextLoader(href)` is consulted for non-data URLs that
/// look like SVG. If absent, *.svg URL hrefs fall through to the
/// raster path (which usually fails because Image() can't draw an
/// SVG-tagged-as-Image into a canvas without taint).
export async function decodeImageHref(href, opts) {
  if (!href) return null;
  opts = opts || {};
  // SVG-content path. Data URL: decode inline. Non-data URL: ask the
  // caller-supplied loader.
  if (isSvgHref(href)) {
    if (/^data:/i.test(href)) {
      const svgText = decodeSvgDataUrl(href);
      if (svgText) return { isSvg: true, svgText };
    } else if (typeof opts.svgTextLoader === 'function') {
      try {
        const svgText = await opts.svgTextLoader(href);
        if (typeof svgText === 'string' && svgText.length > 0) return { isSvg: true, svgText };
      } catch (e) { /* fall through to raster attempt */ }
    }
  }
  // Need a DOM. xmldom-parsed docs have no Image global; bail.
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
  return await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) { resolve(null); return; }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      let data;
      try { data = ctx.getImageData(0, 0, w, h).data; }
      catch (e) { resolve(null); return; }  // tainted (cross-origin)
      resolve({ w, h, rgba: new Uint8Array(data.buffer.slice(0, data.length)) });
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });
}

/// Pre-walk the SVG to find every <image> element and resolve its
/// raster pixel data OR SVG content. Returns Map<element → decoded>
/// where `decoded` is either { isSvg, svgText } or { w, h, rgba }.
/// opts.svgTextLoader (optional) is forwarded to decodeImageHref so
/// non-data SVG URLs resolve via the caller's fetch.
export async function preloadImages(root, opts) {
  const list = [];
  const visit = el => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'image') list.push(el);
    const ks = elementChildren(el);
    for (let i = 0; i < ks.length; i++) visit(ks[i]);
  };
  visit(root);
  const out = new Map();
  for (const el of list) {
    const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
    const dec = await decodeImageHref(href, opts);
    if (dec) out.set(el, dec);
  }
  return out;
}

/// Nearest-neighbor downscale when `w` exceeds `maxW`. Returns the
/// (possibly unchanged) RGBA buffer and dimensions.
export function downscaleRgba8(rgba, w, h, maxW) {
  if (!rgba || w <= 0 || h <= 0 || w <= maxW) return { rgba, w, h };
  const nw = maxW;
  const nh = Math.max(1, Math.round(h * (maxW / w)));
  const out = new Uint8Array(nw * nh * 4);
  const xRatio = w / nw;
  const yRatio = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, (y * yRatio) | 0);
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, (x * xRatio) | 0);
      const si = (sy * w + sx) * 4;
      const di = (y * nw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { rgba: out, w: nw, h: nh };
}
