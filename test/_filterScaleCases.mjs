// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _filterScaleCases.mjs -- the cells of filterScaleRenderSmoke: every length-valued filter primitive attribute (stdDeviation,
// dx / dy, radius, scale, light positions, baseFrequency, feImage placement) is in the USER SPACE of the element that references the filter
// (SVG 1.1 section 15.7.1 / Filter Effects 1 section 3.2 "userSpaceOnUse ... the current user coordinate system in place at the time
// when the filter element is referenced", which includes the element's transform attribute), so a filter under transform="scale(2)"
// reaches twice as far in device space, and under a non-uniform scale or a turn its blur is an ellipse / follows the element's axes.
// Each cell is a 64-unit canvas drawn at 128 px by Mantle and by Chrome's own SVG engine at 8x (box-averaged).
import zlib from 'zlib';
function png(w, h, pixel) {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      len = Buffer.alloc(4),
      c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
const PNG = png(8, 8, (x, y) => ((x + y) & 1 ? [0, 160, 0, 255] : [0, 0, 255, 255]));

/// The element transforms. Every one is placed so the 16 x 16 local square (centered on the origin) lands inside the canvas.
export const TRANSFORMS = {
  id: '',
  s2: 'scale(2)',
  s21: 'scale(2 1)',
  rot: 'rotate(30) scale(1.5)',
  rotAniso: 'rotate(30) scale(2 1)',
  skew: 'skewX(25) scale(1.5)',
  flip: 'scale(-1.5 1.5)',
};
const SRC = '<rect x="-8" y="-8" width="16" height="16" fill="#e04020"/>';
const REG =
  'filterUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120" color-interpolation-filters="sRGB"';
// `bg`: the ground the cell is drawn on (white; lights get a dark one, so a white highlight shows).
const doc = (body, defs = '', bg = 'white') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="128" height="128" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><defs>${defs}</defs>${body}</svg>`;
const tf = (t) => `translate(32 32)${t ? ' ' + t : ''}`;
const filt = (inner, attrs = REG) => `<filter id="f" ${attrs}>${inner}</filter>`;

/// The primitives: the inner markup of the filter (user units), and the source (default SRC).
export const PRIMS = {
  blur: { f: '<feGaussianBlur stdDeviation="2"/>' },
  blurAniso: { f: '<feGaussianBlur stdDeviation="3 1"/>' },
  offset: { f: '<feOffset dx="4" dy="2"/>' },
  dropShadow: { f: '<feDropShadow dx="3" dy="2" stdDeviation="1.5" flood-color="#2060d0"/>' },
  morphDilate: { f: '<feMorphology operator="dilate" radius="2 1"/>' },
  morphErode: {
    f: '<feMorphology operator="erode" radius="1.5"/>',
    src: '<rect x="-10" y="-10" width="20" height="20" fill="#e04020"/>',
  },
  displace: {
    f: '<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="1" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="8" xChannelSelector="R" yChannelSelector="G"/>',
  },
  turbulence: {
    f: '<feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="7"/>',
  },
  lightPoint: {
    f: '<feGaussianBlur in="SourceAlpha" stdDeviation="1.5" result="a"/><feDiffuseLighting in="a" surfaceScale="4" lighting-color="#fff0c0"><fePointLight x="-4" y="-6" z="10"/></feDiffuseLighting>',
    bg: '#202838',
  },
  lightSpot: {
    f: '<feGaussianBlur in="SourceAlpha" stdDeviation="1.5" result="a"/><feSpecularLighting in="a" surfaceScale="4" specularExponent="12" lighting-color="#fff0c0"><feSpotLight x="-6" y="-8" z="12" pointsAtX="0" pointsAtY="0" pointsAtZ="0" limitingConeAngle="40"/></feSpecularLighting>',
    bg: '#202838',
  },
  lightDistant: {
    f: '<feGaussianBlur in="SourceAlpha" stdDeviation="1.5" result="a"/><feDiffuseLighting in="a" surfaceScale="4" lighting-color="#fff0c0"><feDistantLight azimuth="30" elevation="50"/></feDiffuseLighting>',
    bg: '#202838',
  },
  feImage: {
    f: `<feImage href="${PNG}" x="-6" y="-6" width="12" height="12" preserveAspectRatio="none"/>`,
  },
  tile: {
    f: '<feFlood flood-color="#2060d0" x="-8" y="-8" width="6" height="6" result="a"/><feOffset in="a" dx="0" dy="0" x="-8" y="-8" width="12" height="12" result="b"/><feTile in="b"/>',
  },
  two: { f: '<feGaussianBlur stdDeviation="1.5" result="b"/><feOffset in="b" dx="4" dy="3"/>' },
};

/// How the filtered element is built around one transform.
export const VARIANTS = {
  g: (t, p) => doc(`<g transform="${tf(t)}" filter="url(#f)">${p.src || SRC}</g>`, filt(p.f), p.bg),
  el: (t, p) =>
    doc(
      `<rect transform="${tf(t)}" filter="url(#f)" x="-8" y="-8" width="16" height="16" fill="#e04020"/>`,
      filt(p.f),
      p.bg,
    ),
  useIn: (t, p) =>
    doc(
      `<use href="#s" transform="${tf(t)}"/>`,
      `<g id="s" filter="url(#f)">${p.src || SRC}</g>` + filt(p.f),
      p.bg,
    ),
  useEl: (t, p) =>
    doc(
      `<use href="#r" transform="${tf(t)}" filter="url(#f)"/>`,
      `<g id="r">${p.src || SRC}</g>` + filt(p.f),
      p.bg,
    ),
  nested: (t, p) =>
    doc(
      `<g transform="${tf(t)}"><g transform="translate(1 1) scale(1)" filter="url(#f)">${p.src || SRC}</g></g>`,
      filt(p.f),
      p.bg,
    ),
};

/// CSS filter functions: the lengths are in the element's local CSS px, so they scale with its transform too.
export const CSS = {
  blur: (t) => doc(`<g transform="${tf(t)}" style="filter: blur(2px)">${SRC}</g>`),
  dropShadow: (t) =>
    doc(`<g transform="${tf(t)}" style="filter: drop-shadow(3px 2px 1.5px #2060d0)">${SRC}</g>`),
};

/// An <image> that names its filter: the lengths follow its transform, and objectBoundingBox primitive units are of its own box.
const IMG = `<image href="${png(16, 16, (x, y) => (((x >> 2) + (y >> 2)) & 1 ? [224, 64, 32, 255] : [32, 96, 208, 255]))}" x="-8" y="-8" width="16" height="16" filter="url(#f)"/>`;
export const IMAGES = {
  blur: (t) =>
    doc(`<g transform="${tf(t)}">${IMG}</g>`, filt('<feGaussianBlur stdDeviation="2"/>')),
  blurObb: (t) =>
    doc(
      `<g transform="${tf(t)}">${IMG}</g>`,
      filt('<feGaussianBlur stdDeviation="0.1"/>', REG + ' primitiveUnits="objectBoundingBox"'),
    ),
  shadow: (t) =>
    doc(
      `<g transform="${tf(t)}">${IMG}</g>`,
      filt('<feDropShadow dx="3" dy="2" stdDeviation="1.5" flood-color="#2060d0"/>'),
    ),
};
