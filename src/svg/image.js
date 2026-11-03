// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/image.js — <image> href decoding + per-document preload.
//
// Async because in-browser the only way to rasterize an <image> href is
// via the <img>+<canvas> pair (no synchronous browser API exists).
// Node / xmldom contexts without a DOM canvas return null (the caller
// skips the image — graceful degradation).
//
// SVG-content hrefs (data:image/svg+xml,... and *.svg / *.svgz URLs)
// route to a separate path that returns { isSvg: true, svgText, viewBox }
// — the importer walks this recursively, mapping the nested viewBox into
// the outer <image>'s rect, instead of rasterizing.

import { svgElementName, elementChildren } from './utils.js';
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

/// Percent-decoding that never fails (RFC 3986 leaves a stray "%" literal, as browsers do): each run of %XX
/// escapes is the UTF-8 bytes it spells, and a "%" not followed by two hex digits stays as written.
function lenientPercentDecode(body) {
  return body.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.substr(i * 3 + 1, 2), 16);
    return new TextDecoder('utf-8').decode(bytes);
  });
}

/// Base64 payload to bytes: whitespace is ignored, the URL-safe alphabet is accepted, padding is optional.
function base64Bytes(body) {
  let t = body.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(t) || t.length % 4 === 1) return null;
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(t, 'base64'));
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// Extract the SVG text from a data URL whose MIME is image/svg+xml (RFC 2397: `data:[<mime>][;<param>]*[;base64],<body>`).
/// Any parameter is accepted (`;charset=`, `;utf8`, `;name=`), and the body is base64 or percent-encoded text, both read
/// as UTF-8. Returns null on parse failure. Raster data URLs are never decoded here: the browser reads their bytes.
export function decodeSvgDataUrl(href) {
  if (!href) return null;
  const m = /^data:image\/svg\+xml((?:;[^;,]*)*),([\s\S]*)$/i.exec(href.trim());
  if (!m) return null;
  const isB64 = m[1].split(';').some((p) => p.trim().toLowerCase() === 'base64');
  if (isB64) {
    const bytes = base64Bytes(m[2]);
    return bytes ? new TextDecoder('utf-8').decode(bytes) : null;
  }
  return lenientPercentDecode(m[2]);
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
      } catch (e) {
        /* fall through to raster attempt */
      }
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
      if (!w || !h) {
        resolve(null);
        return;
      }
      // The decode runs off the main thread (img.decode()), so the drawImage below does not decode a large raster synchronously (a 421 ms task on a
      // big photo), and the canvas is CPU-backed (willReadFrequently), so the read-back is a copy and not a GPU round trip.
      const read = () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        let data;
        try {
          data = ctx.getImageData(0, 0, w, h).data;
        } catch (e) {
          resolve(null);
          return;
        } // tainted (cross-origin)
        resolve({ w, h, rgba: new Uint8Array(data.buffer.slice(0, data.length)) });
      };
      if (typeof img.decode === 'function') img.decode().then(read, read);
      else read();
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });
}

/// True for an <feImage> whose href is an EXTERNAL raster: not a "#id"
/// reference to an element, and not SVG (which a filter input would have to
/// rasterize at a resolution nothing here knows).
function isExternalRasterFeImage(el) {
  const href = (el.getAttribute('href') || el.getAttribute('xlink:href') || '').trim();
  return !!href && href[0] !== '#' && !isSvgHref(href);
}

/// Pre-walk the SVG to find every <image> element, and every <feImage> with
/// an external raster href, and resolve its raster pixel data OR SVG content.
/// Returns Map<element → decoded> where `decoded` is either { isSvg, svgText }
/// or { w, h, rgba }. opts.svgTextLoader (optional) is forwarded to
/// decodeImageHref so non-data SVG URLs resolve via the caller's fetch.
/// `accept(el)`, when given, is asked first and an element it refuses is not
/// loaded at all.
export async function preloadImages(root, opts, accept, byHref = new Map()) {
  const list = [];
  const visit = (el) => {
    const tag = svgElementName(el);
    if (
      (tag === 'image' || (tag === 'feimage' && isExternalRasterFeImage(el))) &&
      (!accept || accept(el))
    )
      list.push(el);
    const ks = elementChildren(el);
    for (let i = 0; i < ks.length; i++) visit(ks[i]);
  };
  visit(root);
  // Decode concurrently — each image is an independent fetch + decode, so
  // serial awaiting stacks N round trips of latency into importSvg.
  // ...but each DISTINCT href once: the same image embedded twice is one decode, and the elements share the record, which is
  // what lets claimImage give them one atlas region. (Elements of different hrefs never share.)
  const decoded = await Promise.all(
    list.map((el) => {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      let p = byHref.get(href);
      if (!p) {
        p = decodeImageHref(href, opts);
        byHref.set(href, p);
      }
      return p;
    }),
  );
  const out = new Map();
  for (let i = 0; i < list.length; i++) {
    if (decoded[i]) out.set(list[i], decoded[i]);
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
