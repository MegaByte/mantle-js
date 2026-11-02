// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Minimal UCD text parsers. All return plain arrays/maps keyed by codepoint.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pinned to Unicode 18.0.0 (latest stable; released Sept 2026). Every source URL
// in fetchUcd is derived from this constant — including the emoji tree — and the
// fetch refuses redirects and requires the version's ReadMe to say "final data
// files", so the pin is reproducible and cannot silently vendor a beta. Bump
// this constant to move versions, then re-run fetchUcd + genUnicodeTables.
export const UCD_VERSION = '18.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));
export const UCD_DIR = join(HERE, '..', '.ucd-cache');

export function ucd(name) {
  return readFileSync(join(UCD_DIR, name), 'utf8');
}

// Parse UnicodeData.txt. Handles "<..., First>" / "<..., Last>" range pairs.
// Returns { ccc:Uint8Array, decomp:Map<cp,{compat:bool,cps:number[]}>,
//           gc:string[], bidi:string[], mirrored:Set<number> }.
export function parseUnicodeData(text = ucd('UnicodeData.txt')) {
  const ccc = new Uint8Array(0x110000);
  const decomp = new Map();
  const gc = new Array(0x110000);
  const bidi = new Array(0x110000);
  const mirrored = new Set();
  let rangeStart = -1;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = line.split(';');
    const cp = parseInt(f[0], 16);
    const name = f[1];
    if (name.endsWith(', First>')) {
      rangeStart = cp;
      continue;
    }
    if (name.endsWith(', Last>')) {
      for (let c = rangeStart; c <= cp; c++) {
        gc[c] = f[2];
        bidi[c] = f[4];
        ccc[c] = clampCcc(f[3]);
      }
      rangeStart = -1;
      continue;
    }
    gc[cp] = f[2];
    bidi[cp] = f[4];
    ccc[cp] = clampCcc(f[3]);
    if (f[9] === 'Y') mirrored.add(cp);
    const dec = f[5];
    if (dec) {
      let compat = false;
      let parts = dec.trim().split(/\s+/);
      if (parts[0].startsWith('<')) {
        compat = true;
        parts = parts.slice(1);
      }
      decomp.set(cp, { compat, cps: parts.map((h) => parseInt(h, 16)) });
    }
  }
  return { ccc, decomp, gc, bidi, mirrored };
}

function clampCcc(s) {
  const v = parseInt(s, 10) || 0;
  return v > 254 ? 254 : v;
}

// Parse a "cp | cp..cp ; Value # comment" property file into an array of
// per-codepoint string values (field index `field`, default 1 = first after cp).
export function parseEnumProp(text, field = 0) {
  const out = new Array(0x110000);
  for (let line of text.split('\n')) {
    const h = line.indexOf('#');
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(';').map((s) => s.trim());
    const [lo, hi] = parseRange(f[0]);
    const val = f[1 + field];
    if (val === undefined) continue;
    for (let c = lo; c <= hi; c++) out[c] = val;
  }
  return out;
}

// Parse a list of ranges that all carry one property (e.g. emoji-data lines
// filtered by a given property name in field 1). Returns Set<number> or fills.
export function parseBinaryProp(text, propName) {
  const set = new Set();
  for (let line of text.split('\n')) {
    const h = line.indexOf('#');
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(';').map((s) => s.trim());
    if (propName && f[1] !== propName) continue;
    const [lo, hi] = parseRange(f[0]);
    for (let c = lo; c <= hi; c++) set.add(c);
  }
  return set;
}

// Parse a catalog property from a multi-property file (e.g. DerivedCoreProperties
// "cp ; InCB ; Value"): keep lines whose field 1 == propName, value = field 2.
export function parseCatalog(text, propName) {
  const out = new Array(0x110000);
  for (let line of text.split('\n')) {
    const h = line.indexOf('#');
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(';').map((s) => s.trim());
    if (f[1] !== propName) continue;
    const [lo, hi] = parseRange(f[0]);
    for (let c = lo; c <= hi; c++) out[c] = f[2];
  }
  return out;
}

export function parseRange(s) {
  const m = s.split('..');
  const lo = parseInt(m[0], 16);
  const hi = m.length > 1 ? parseInt(m[1], 16) : lo;
  return [lo, hi];
}

// Map an array of string enum values -> { ids:Uint8Array(per cp), names:string[] }
// `order` optionally pins id assignment (so JS and C# enums match a fixed order).
export function enumerate(values, defaultName, order) {
  const names = order ? order.slice() : [defaultName];
  const idOf = new Map(names.map((n, i) => [n, i]));
  const ids = new Uint8Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) {
    const v = values[cp] ?? defaultName;
    let id = idOf.get(v);
    if (id === undefined) {
      id = names.length;
      names.push(v);
      idOf.set(v, id);
    }
    ids[cp] = id;
  }
  if (names.length > 256) throw new Error('enum exceeds 256 values; widen trie');
  return { ids, names };
}
