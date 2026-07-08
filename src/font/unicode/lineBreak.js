// Line breaking (UAX #14), Unicode 17 rule set. Classes are pre-resolved per LB1
// in the table (AI/SG/XX->AL, CJ->NS, SA->CM/AL), so this implements LB2-LB31.
// Returns a break action before each index: PROHIBITED / ALLOWED / MANDATORY.
import { lineBreak, Lb } from "./tables/lineBreak.js";
import { eastAsianWidth, Eaw } from "./tables/eastAsianWidth.js";
import { extPict } from "./tables/extPict.js";

const extPictTrie = (cp) => extPict.get(cp);

export const PROHIBITED = 0;
export const ALLOWED = 1;
export const MANDATORY = 2;

// Class ids (by name, so they track the generated enum).
const {
  AL, CM, BA, LF, BK, CR, SP, EX, QU, QU_PI, QU_PF, PR, PO, OP, CP, IS, HY, SY,
  NU, CL, NL, GL, BB, HH, HL, JL, JV, JT, NS, AK, VI, AS, ID, VF, ZW, ZWJ, B2,
  IN, WJ, EB, H2, H3, CB, AP, RI, EM,
} = Lb;

const cls = (cp) => lineBreak.get(cp);
const isQU = (x) => x === QU || x === QU_PI || x === QU_PF;
// East-Asian (F/W/H) — excluded from LB30's OP/CP no-break.
const eaIsWide = (cp) => {
  const w = eastAsianWidth.get(cp);
  return w === Eaw.F || w === Eaw.W || w === Eaw.H;
};

/**
 * Compute line-break actions. Returns array of length n+1; entry i is the
 * action for a break BEFORE code point i (entry 0 = sot PROHIBITED, n = eot
 * MANDATORY). Input is an array of code points.
 */
export function lineBreakActions(cps) {
  const n = cps.length;
  const out = new Array(n + 1).fill(ALLOWED);
  out[0] = PROHIBITED;
  if (n === 0) return out;
  out[n] = MANDATORY;

  // Effective classes with LB9 folding: CM/ZWJ attach to the preceding char
  // (unless preceded by a mandatory break or space/ZW), else become AL (LB10).
  const c = new Array(n);
  for (let i = 0; i < n; i++) c[i] = cls(cps[i]);
  // raw[i] keeps the original class (needed for ZWJ LB8a and CM/ZWJ detection).
  const raw = c.slice();
  // attached[i]: this CM/ZWJ folded onto the preceding char (LB9), so the break
  // before it is prohibited. CM/ZWJ at sot or after a break/space become AL (LB10).
  const attached = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (raw[i] === CM || raw[i] === ZWJ) {
      if (i === 0) c[i] = AL;
      else {
        const p = c[i - 1];
        if (p === BK || p === CR || p === LF || p === NL || p === SP || p === ZW) c[i] = AL;
        else {
          c[i] = p;
          attached[i] = true;
        }
      }
    }
  }

  // Cluster base index: attached CM/ZWJ inherit the base char's index, so rules
  // that need the base code point (LB20a hyphen-at-start, LB28a dotted circle)
  // can see through combining marks.
  const baseIdx = new Array(n);
  for (let i = 0; i < n; i++) baseIdx[i] = attached[i] ? baseIdx[i - 1] : i;

  // LB25 number cohesion: mark interior joints of maximal numeric expressions
  //   (PR|PO)? (OP|HY)? NU (NU|SY|IS)* (CL|CP)? (PR|PO)?
  // This carries the context for the (CL|CP) × (PR|PO) joint, which (unlike the
  // other LB25 joints) only holds when the bracket closes a number.
  const numNoBreak = new Array(n + 1).fill(false);
  for (let i = 0; i < n; ) {
    let j = i;
    if (c[j] === PR || c[j] === PO) j++;
    if (c[j] === OP || c[j] === HY) j++;
    if (j < n && c[j] === NU) {
      j++;
      while (j < n && (c[j] === NU || c[j] === SY || c[j] === IS)) j++;
      if (j < n && (c[j] === CL || c[j] === CP)) j++;
      let trailingSign = false;
      if (j < n && (c[j] === PR || c[j] === PO)) {
        j++;
        trailingSign = true;
      }
      for (let k = i + 1; k < j; k++) numNoBreak[k] = true;
      // Join to an immediately-following number group (e.g. "(0,1)+(2,3)"): a
      // trailing PR/PO that leads straight into another number is not a break.
      if (trailingSign && (c[j] === NU || ((c[j] === OP || c[j] === HY) && c[j + 1] === NU))) {
        numNoBreak[j] = true;
      }
      i = j;
    } else {
      i++;
    }
  }

  // State across boundaries.
  let riParity = 0; // consecutive RI count (for LB30a)
  for (let i = 1; i < n; i++) {
    const b = c[i - 1];
    const a = c[i];
    // Track regional-indicator parity on the left side, counting only real RI
    // bases (an attached combining mark folds to RI but must not inflate it).
    if (attached[i - 1]) {
      // leave riParity unchanged
    } else if (c[i - 1] === RI) riParity++;
    else riParity = 0;

    out[i] = decide(cps, c, raw, attached, baseIdx, numNoBreak, i, b, a, riParity);
  }
  return out;
}

// Find the class to the left, skipping SP, plus whether spaces intervened.
function leftBase(c, i) {
  let j = i - 1;
  let sawSP = false;
  while (j >= 0 && c[j] === SP) {
    sawSP = true;
    j--;
  }
  return { cls: j >= 0 ? c[j] : -1, sawSP, idx: j };
}

function decide(cps, c, raw, attached, baseIdx, numNoBreak, i, b, a, riParity) {
  // LB4: BK !  (mandatory after BK)
  if (b === BK) return MANDATORY;
  // LB5: CR × LF; CR/LF/NL !
  if (b === CR) return a === LF ? PROHIBITED : MANDATORY;
  if (b === LF || b === NL) return MANDATORY;
  // LB6: × before BK/CR/LF/NL
  if (a === BK || a === CR || a === LF || a === NL) return PROHIBITED;
  // LB7: × SP; × ZW
  if (a === SP || a === ZW) return PROHIBITED;
  // LB8: ZW SP* ÷  — break after ZW even through spaces
  {
    const lb = leftBase(c, i);
    if (lb.cls === ZW) return ALLOWED;
  }
  // LB8a: ZWJ ×  (no break after ZWJ)
  if (raw[i - 1] === ZWJ) return PROHIBITED;
  // LB9: × CM/ZWJ that attached to the preceding char.
  if (attached[i]) return PROHIBITED;
  // LB11: × WJ; WJ ×
  if (a === WJ || b === WJ) return PROHIBITED;
  // LB12: GL ×
  if (b === GL) return PROHIBITED;
  // LB12a: [^SP BA HY HH] × GL  (a hyphen, incl. the unambiguous HH, allows a
  // break before GL/NBSP)
  if (a === GL && b !== SP && b !== BA && b !== HY && b !== HH) return PROHIBITED;
  // LB13: × CL, CP, EX, SY (IS is handled by LB15c/d so a space can precede it)
  if (a === CL || a === CP || a === EX || a === SY) return PROHIBITED;
  // LB14: OP SP* ×
  {
    const lb = leftBase(c, i);
    if (lb.cls === OP) return PROHIBITED;
  }
  // LB15a: (sot|BK|CR|LF|NL|OP|QU|GL|SP|ZW) [QU&Pi] SP* ×  — opening quote
  {
    const lb = leftBase(c, i);
    if (lb.cls === QU_PI) {
      const before = lb.idx - 1 >= 0 ? c[lb.idx - 1] : -2;
      if (
        lb.idx === 0 || before === BK || before === CR || before === LF || before === NL ||
        before === OP || isQU(before) || before === GL || before === SP || before === ZW
      ) {
        return PROHIBITED; // LB15a
      }
    }
  }
  // LB15b: × [QU&Pf] (SP|GL|WJ|CL|QU|CP|EX|IS|SY|BK|CR|LF|NL|ZW|eot)  — closing quote
  if (a === QU_PF) {
    const nextC = i + 1 < c.length ? c[i + 1] : -1;
    if (
      nextC === SP || nextC === GL || nextC === WJ || nextC === CL || isQU(nextC) ||
      nextC === CP || nextC === EX || nextC === IS || nextC === SY || nextC === BK ||
      nextC === CR || nextC === LF || nextC === NL || nextC === ZW || nextC === -1
    ) {
      return PROHIBITED;
    }
  }
  // LB15c: SP ÷ IS NU  (a space then a decimal separator that leads a number)
  if (b === SP && a === IS && i + 1 < c.length && c[i + 1] === NU) return ALLOWED;
  // LB15d: × IS  (otherwise no break before a separator)
  if (a === IS) return PROHIBITED;
  // LB16: (CL|CP) SP* × NS
  {
    const lb = leftBase(c, i);
    if ((lb.cls === CL || lb.cls === CP) && a === NS) return PROHIBITED;
  }
  // LB17: B2 SP* × B2
  {
    const lb = leftBase(c, i);
    if (lb.cls === B2 && a === B2) return PROHIBITED;
  }
  // LB18: SP ÷  (break after space)
  if (b === SP) return ALLOWED;
  // LB19: × [QU - Pi] ; [QU - Pf] × . LB19a relaxes Pi/Pf quotes only when they
  // sit between two East-Asian characters (so CJK text can break around quotes).
  if (isQU(a)) {
    if (a !== QU_PI) return PROHIBITED; // × non-initial quote
    const beforeEA = eaIsWide(cps[baseIdx[i - 1]]);
    const afterEA = i + 1 < c.length && eaIsWide(cps[i + 1]);
    if (!beforeEA || !afterEA) return PROHIBITED;
  }
  if (isQU(b)) {
    if (b !== QU_PF) return PROHIBITED; // non-final quote ×
    const afterEA = eaIsWide(cps[i]);
    const prevIdx = baseIdx[i - 1] - 1;
    const beforeEA = prevIdx >= 0 && eaIsWide(cps[prevIdx]);
    if (!afterEA || !beforeEA) return PROHIBITED;
  }
  // LB20: ÷ CB; CB ÷
  if (a === CB || b === CB) return ALLOWED;
  // LB20a: (sot|BK|CR|LF|NL|SP|ZW|CB|GL) (HY|HH) × (AL|HL)  — word-initial hyphen.
  if ((b === HY || b === HH) && (a === AL || a === HL)) {
    const hyIdx = baseIdx[i - 1]; // the hyphen, seen through any attached CM
    const before = hyIdx - 1 >= 0 ? c[hyIdx - 1] : -1;
    if (
      hyIdx === 0 || before === BK || before === CR || before === LF || before === NL ||
      before === SP || before === ZW || before === CB || before === GL
    ) {
      return PROHIBITED;
    }
  }
  // LB21: × BA; × HY; × NS; BB ×
  if (a === BA || a === HY || a === NS || a === HH) return PROHIBITED;
  if (b === BB) return PROHIBITED;
  // LB21a: HL (HY|HH) × [^HL]  (a hyphen after a Hebrew letter; not plain BA)
  if (i - 2 >= 0 && c[i - 2] === HL && (b === HY || b === HH) && a !== HL) return PROHIBITED;
  // LB21b: SY × HL
  if (b === SY && a === HL) return PROHIBITED;
  // LB22: × IN
  if (a === IN) return PROHIBITED;
  // LB23: (AL|HL) × NU; NU × (AL|HL)
  if ((b === AL || b === HL) && a === NU) return PROHIBITED;
  if (b === NU && (a === AL || a === HL)) return PROHIBITED;
  // LB23a: PR × (ID|EB|EM); (ID|EB|EM) × PO
  if (b === PR && (a === ID || a === EB || a === EM)) return PROHIBITED;
  if ((b === ID || b === EB || b === EM) && a === PO) return PROHIBITED;
  // LB24: (PR|PO) × (AL|HL); (AL|HL) × (PR|PO)
  if ((b === PR || b === PO) && (a === AL || a === HL)) return PROHIBITED;
  if ((b === AL || b === HL) && (a === PR || a === PO)) return PROHIBITED;
  // LB25: number cohesion via the regex (which carries context for the bracket
  // and PR/PO joints). The one context-free joint is IS × NU.
  if (numNoBreak[i]) return PROHIBITED;
  if (b === IS && a === NU) return PROHIBITED;
  // LB26: Korean syllable blocks
  if (b === JL && (a === JL || a === JV || a === H2 || a === H3)) return PROHIBITED;
  if ((b === JV || b === H2) && (a === JV || a === JT)) return PROHIBITED;
  if ((b === JT || b === H3) && a === JT) return PROHIBITED;
  // LB27: Korean + PR/PO
  if ((b === JL || b === JV || b === JT || b === H2 || b === H3) && a === PO) return PROHIBITED;
  if (b === PR && (a === JL || a === JV || a === JT || a === H2 || a === H3)) return PROHIBITED;
  // LB28: (AL|HL) × (AL|HL)
  if ((b === AL || b === HL) && (a === AL || a === HL)) return PROHIBITED;
  // LB28a: Brahmic orthographic syllables (viramas). ◌ = U+25CC dotted circle.
  {
    const dotL = cps[baseIdx[i - 1]] === 0x25cc;
    const dotA = cps[i] === 0x25cc;
    const akL = b === AK || b === AS || dotL;
    const akA = a === AK || a === AS || dotA;
    // AP × (AK | ◌ | AS)
    if (b === AP && akA) return PROHIBITED;
    // (AK | ◌ | AS) × (VF | VI)
    if (akL && (a === VF || a === VI)) return PROHIBITED;
    // (AK | ◌ | AS) VI × (AK | ◌) — see the virama through an attached mark (ZWNJ,
    // Javanese/Balinese signs) via baseIdx.
    {
      const viIdx = baseIdx[i - 1];
      if (c[viIdx] === VI) {
        const pIdx = viIdx - 1 >= 0 ? baseIdx[viIdx - 1] : -1;
        if (pIdx >= 0 && (c[pIdx] === AK || c[pIdx] === AS || cps[pIdx] === 0x25cc) && (a === AK || dotA))
          return PROHIBITED;
      }
    }
    // (AK | ◌ | AS) × (AK | ◌ | AS) when followed by VF
    if (akL && akA && i + 1 < c.length && c[i + 1] === VF) return PROHIBITED;
  }
  // LB29: IS × (AL|HL)
  if (b === IS && (a === AL || a === HL)) return PROHIBITED;
  // LB30: (AL|HL|NU) × OP(non-EAW); CP(non-EAW) × (AL|HL|NU)
  if ((b === AL || b === HL || b === NU) && a === OP && !eaIsWide(cps[i])) return PROHIBITED;
  if (b === CP && !eaIsWide(cps[i - 1]) && (a === AL || a === HL || a === NU)) return PROHIBITED;
  // LB30a: RI RI ÷ — keep flag pairs together (odd count ending at b => a closes the pair)
  if (b === RI && a === RI && riParity % 2 === 1) return PROHIBITED;
  // LB30b: EB × EM; (Extended_Pictographic & Cn) × EM
  if (b === EB && a === EM) return PROHIBITED;
  if (a === EM && extPictTrie(cps[baseIdx[i - 1]]) === 2) return PROHIBITED;
  // LB31: ALL ÷ ALL
  return ALLOWED;
}

