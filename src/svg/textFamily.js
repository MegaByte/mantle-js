// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/textFamily.js — font-family list matching for SVG <text> against the importer's `fonts` map.
//
// CSS Fonts 4 §3.1: `font-family` is a comma-separated list of family names (quoted or bare, matched ASCII
// case-insensitively with runs of white space collapsed) and generic keywords. The first listed family the `fonts`
// map holds is the primary font; every later one it holds is a fallback for the codepoints the primary lacks.

/// The names of a font-family list, unquoted, white space collapsed. Commas inside quotes do not split.
export function splitFontFamilyList(raw) {
  const out = [];
  const text = String(raw ?? '');
  let cur = '',
    quote = '';
  const flush = () => {
    const n = cur.trim().replace(/\s+/g, ' ');
    if (n) out.push(n);
    cur = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && i + 1 < text.length) cur += text[++i];
      else if (c === quote) quote = '';
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ',') flush();
    else cur += c;
  }
  flush();
  return out;
}

const has = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

/// A resolver for `fontMap` (a plain object of family name -> font, or null): `resolve(raw)` returns
/// { font, fallbacks } (fallbacks is undefined when the list names no second font) or null when no listed family is held.
/// The whole attribute value is tried as a key first, so a map keyed by a full list still matches as it always has.
export function makeFamilyResolver(fontMap) {
  if (!fontMap) return () => null;
  let lower = null;
  const lowerIndex = () => {
    if (lower) return lower;
    lower = new Map();
    for (const k of Object.keys(fontMap)) {
      if (!fontMap[k]) continue;
      const n = String(k).trim().replace(/\s+/g, ' ').toLowerCase();
      if (!lower.has(n)) lower.set(n, fontMap[k]);
    }
    return lower;
  };
  const cache = new Map();
  return (raw) => {
    const key = String(raw ?? '');
    if (cache.has(key)) return cache.get(key);
    let res = null;
    const trimmed = key.trim();
    const stripped = trimmed.replace(/^["']|["']$/g, '');
    if (trimmed && has(fontMap, trimmed) && fontMap[trimmed])
      res = { font: fontMap[trimmed], fallbacks: undefined };
    else if (stripped && has(fontMap, stripped) && fontMap[stripped])
      res = { font: fontMap[stripped], fallbacks: undefined };
    else {
      const found = [];
      for (const name of splitFontFamilyList(key)) {
        const font = (has(fontMap, name) && fontMap[name]) || lowerIndex().get(name.toLowerCase());
        if (font && !found.includes(font)) found.push(font);
      }
      if (found.length)
        res = { font: found[0], fallbacks: found.length > 1 ? found.slice(1) : undefined };
    }
    cache.set(key, res);
    return res;
  };
}
