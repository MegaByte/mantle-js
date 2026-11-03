// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fvarReader.js — OpenType 'fvar' table reader.
//
// Parses variation axes + named instances: enumerate axes (wght, wdth,
// ...), resolve named instances, bind a per-render axis-coord vector.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/fvar

import { NameTable } from '../nameReader.js';
import { AvarTable } from './avarReader.js';

/** Tag → 4-char ASCII helper. */
function tagToString(tag) {
  return String.fromCharCode((tag >> 24) & 0xff, (tag >> 16) & 0xff, (tag >> 8) & 0xff, tag & 0xff);
}

// Fixed point 16.16 → JS number. `hi` is signed (s16).
function fixed16_16(hi, lo) {
  const i = (hi << 16) | (lo & 0xffff);
  return i / 65536;
}

export class FvarTable {
  constructor(tables) {
    this._axes = null;
    this._instances = null;
    if (!tables.fvar) return;
    const v = tables.view;
    const off = tables.fvar[0];
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    // const minor = v.getUint16(off + 2, false);
    const axesOff = v.getUint16(off + 4, false);
    // const reserved     = v.getUint16(off + 6, false);
    const axisCount = v.getUint16(off + 8, false);
    const axisSize = v.getUint16(off + 10, false);
    const instanceCount = v.getUint16(off + 12, false);
    const instanceSize = v.getUint16(off + 14, false);

    const axesBase = off + axesOff;
    const axes = new Array(axisCount);
    for (let i = 0; i < axisCount; i++) {
      const r = axesBase + i * axisSize;
      const axisTag = v.getUint32(r + 0, false);
      const minHi = v.getInt16(r + 4, false),
        minLo = v.getUint16(r + 6, false);
      const defHi = v.getInt16(r + 8, false),
        defLo = v.getUint16(r + 10, false);
      const maxHi = v.getInt16(r + 12, false),
        maxLo = v.getUint16(r + 14, false);
      const flags = v.getUint16(r + 16, false);
      const axisNameID = v.getUint16(r + 18, false);
      axes[i] = {
        tag: tagToString(axisTag),
        tagInt: axisTag,
        min: fixed16_16(minHi, minLo),
        default: fixed16_16(defHi, defLo),
        max: fixed16_16(maxHi, maxLo),
        hidden: (flags & 0x0001) !== 0,
        nameID: axisNameID,
      };
    }
    this._axes = axes;

    // Instances follow axes. Each record: subfamilyNameID(u16) +
    //   flags(u16) + coordinates[axisCount] (Fixed 16.16 each) +
    //   optional postScriptNameID (u16; present iff instanceSize >=
    //   4 + 4*axisCount + 2).
    const instBase = axesBase + axisCount * axisSize;
    const hasPSName = instanceSize >= 4 + 4 * axisCount + 2;
    const instances = new Array(instanceCount);
    for (let i = 0; i < instanceCount; i++) {
      const r = instBase + i * instanceSize;
      const subfamilyNameID = v.getUint16(r + 0, false);
      // const flags2          = v.getUint16(r + 2, false);
      const coords = new Array(axisCount);
      for (let a = 0; a < axisCount; a++) {
        const cHi = v.getInt16(r + 4 + a * 4, false);
        const cLo = v.getUint16(r + 4 + a * 4 + 2, false);
        coords[a] = fixed16_16(cHi, cLo);
      }
      const psID = hasPSName ? v.getUint16(r + 4 + axisCount * 4, false) : 0;
      instances[i] = {
        subfamilyNameID,
        postScriptNameID: psID,
        coords,
      };
    }
    this._instances = instances;
    // Names + avar resolved lazily — callers may not need them.
    this._tables = tables;
    this._namesResolved = false;
    this._avar = null;
  }

  get isVariable() {
    return this._axes != null && this._axes.length > 0;
  }
  get axes() {
    this._resolveNames();
    return this._axes;
  }
  get instances() {
    this._resolveNames();
    return this._instances;
  }

  /// Find an axis by 4-char tag (e.g. 'wght'); null when absent.
  findAxis(tag) {
    if (!this._axes) return null;
    for (const a of this._axes) if (a.tag === tag) return a;
    return null;
  }

  /// Default coordinate vector — one Fixed per axis at its `default`.
  defaultCoords() {
    if (!this._axes) return [];
    return this._axes.map((a) => a.default);
  }

  /// Clamp + normalize a user-space coordinate vector or axis-tag map to per-axis
  /// (min, default, max) → (-1, 0, +1) — the canonical variation
  /// space gvar/HVAR/etc. operate in. When the font carries an `avar`
  /// table, its piecewise-linear segment map remaps the result.
  normalizeCoords(userCoords) {
    if (!this._axes) return [];
    const n = this._axes.length;
    const tagged = userCoords != null && typeof userCoords.length !== 'number';
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = this._axes[i];
      const value = tagged
        ? userCoords[a.tag]
        : userCoords != null && i < userCoords.length
          ? userCoords[i]
          : undefined;
      // OpenType normalization starts with a 16.16 user coordinate.
      let u = Math.floor((value == null ? a.default : value) * 65536 + 0.5) / 65536;
      if (u < a.min) u = a.min;
      if (u > a.max) u = a.max;
      if (u === a.default) {
        out[i] = 0;
        continue;
      }
      if (u < a.default) out[i] = (u - a.default) / (a.default - a.min);
      else out[i] = (u - a.default) / (a.max - a.default);
    }
    for (let i = 0; i < n; i++) {
      out[i] = Math.max(-1, Math.min(1, Math.floor(out[i] * 65536 + 0.5) / 65536));
    }
    // Apply avar axis-value remap when present.
    if (this._avar == null) this._avar = new AvarTable(this._tables);
    if (this._avar.hasAvar) this._avar.remapCoords(out);
    // Add two before the signed two-bit shift from 16.16 to 2.14.
    for (let i = 0; i < n; i++) {
      const fixed = Math.floor(Math.max(-1, Math.min(1, out[i])) * 65536 + 0.5);
      out[i] = Math.floor((fixed + 2) / 4) / 16384;
    }
    return out;
  }

  _resolveNames() {
    if (this._namesResolved || !this._axes) return;
    this._namesResolved = true;
    const nt = new NameTable(this._tables);
    if (!nt.hasNames) return;
    for (const a of this._axes) {
      a.name = nt.get(a.nameID) || '';
    }
    if (this._instances) {
      for (const inst of this._instances) {
        inst.subfamilyName = nt.get(inst.subfamilyNameID) || '';
        inst.postScriptName = inst.postScriptNameID > 0 ? nt.get(inst.postScriptNameID) || '' : '';
      }
    }
  }
}
