// indicAllScriptsSmoke.mjs — verifies the 7 additional Indic scripts
// classify correctly: Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
// Malayalam, Sinhala.

import {
  Isc, Ipc,
  indicScriptOf, isIndicCodepoint,
  classifyIsc, classifyIpc,
  reorderSyllable,
} from '../../src/font/scripts/indicShaper.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: script bucketing covers all 10 scripts ------------------
{
  const cases = [
    [0x0915, 'deva', 'Devanagari ka'],
    [0x0995, 'beng', 'Bengali ka'],
    [0x0A15, 'guru', 'Gurmukhi ka'],
    [0x0A95, 'gujr', 'Gujarati ka'],
    [0x0B15, 'orya', 'Oriya ka'],
    [0x0B95, 'taml', 'Tamil ka'],
    [0x0C15, 'telu', 'Telugu ka'],
    [0x0C95, 'knda', 'Kannada ka'],
    [0x0D15, 'mlym', 'Malayalam ka'],
    [0x0D9A, 'sinh', 'Sinhala ka'],
  ];
  let allOk = true;
  for (const [cp, want, label] of cases) {
    const got = indicScriptOf(cp);
    if (got !== want) { fail(`T1 ${label}: got ${got}, want ${want}`); allOk = false; }
  }
  if (allOk) ok(`T1 indicScriptOf: 10 scripts bucketed correctly`);
}

// ----- T2: RA classified correctly per script ----------------------
{
  const cases = [
    [0x0930, 'Deva ra'],
    [0x09B0, 'Beng ra'],
    [0x0A30, 'Guru ra'],
    [0x0AB0, 'Gujr ra'],
    [0x0B30, 'Orya ra'],
    [0x0BB0, 'Taml ra'],
    [0x0C30, 'Telu ra'],
    [0x0CB0, 'Knda ra'],
    [0x0D30, 'Mlym ra'],
    [0x0DBB, 'Sinh ra (different offset!)'],
  ];
  let allOk = true;
  for (const [cp, label] of cases) {
    if (classifyIsc(cp) !== Isc.Ra) { fail(`T2 ${label} U+${cp.toString(16)} not Ra`); allOk = false; }
  }
  if (allOk) ok(`T2 RA codepoint classified as Isc.Ra across all 10 scripts`);
}

// ----- T3: Halant per-script ---------------------------------------
{
  const cases = [
    [0x094D, 'Deva halant'],
    [0x09CD, 'Beng halant'],
    [0x0A4D, 'Guru halant'],
    [0x0ACD, 'Gujr halant'],
    [0x0B4D, 'Orya halant'],
    [0x0BCD, 'Taml halant'],
    [0x0C4D, 'Telu halant'],
    [0x0CCD, 'Knda halant'],
    [0x0D4D, 'Mlym halant'],
    [0x0DCA, 'Sinh halant (different offset!)'],
  ];
  let allOk = true;
  for (const [cp, label] of cases) {
    if (classifyIsc(cp) !== Isc.Halant) { fail(`T3 ${label} U+${cp.toString(16)} not Halant`); allOk = false; }
  }
  if (allOk) ok(`T3 halant classified across all 10 scripts (Sinhala at 0x0DCA)`);
}

// ----- T4: Pre-base matras --------------------------------------
{
  // Scripts WITH pre-base matras and which cps to check.
  const cases = [
    ['Deva i',   0x093F],
    ['Beng i',   0x09BF],
    ['Beng e',   0x09C7],
    ['Beng ai',  0x09C8],
    ['Guru i',   0x0A3F],
    ['Gujr i',   0x0ABF],
    ['Orya e',   0x0B47],
    ['Taml e',   0x0BC6],
    ['Taml ee',  0x0BC7],
    ['Taml ai',  0x0BC8],
    ['Mlym e',   0x0D46],
    ['Mlym ee',  0x0D47],
    ['Mlym ai',  0x0D48],
    ['Sinh e',   0x0DD9],
    ['Sinh ai',  0x0DDB],
  ];
  let allOk = true;
  for (const [label, cp] of cases) {
    if (classifyIpc(cp) !== Ipc.Left) {
      fail(`T4 ${label} U+${cp.toString(16)} not Left, got ${classifyIpc(cp)}`); allOk = false;
    }
  }
  if (allOk) ok(`T4 ${cases.length} pre-base matras across Deva/Beng/Guru/Gujr/Orya/Taml/Mlym/Sinh`);
}

// ----- T5: Telugu + Kannada have NO pre-base matras ----------------
{
  // Spot check a few Telugu/Kannada dep vowels — should all be NOT Left.
  const cases = [
    [0x0C3F, 'Telu i'],
    [0x0C40, 'Telu ii'],
    [0x0C46, 'Telu e'],
    [0x0CBF, 'Knda i'],
    [0x0CC6, 'Knda e'],
  ];
  let allOk = true;
  for (const [cp, label] of cases) {
    if (classifyIpc(cp) === Ipc.Left) { fail(`T5 ${label} unexpectedly Left`); allOk = false; }
  }
  if (allOk) ok(`T5 Telu/Knda dep vowels are NOT Left (no pre-base matras in these scripts)`);
}

// ----- T6: Tamil 'கி' (ka + i) — but Tamil 'i' is POST-base ------
{
  // Tamil 'i' (0x0BBF) is NOT in the pre-base list (it's post-base).
  // So reordering should be identity for Tamil 'ki'.
  if (classifyIpc(0x0BBF) === Ipc.Left) fail('T6 Tamil i wrongly Left');
  // But Tamil 'e' (0x0BC6) IS pre-base.
  if (classifyIpc(0x0BC6) !== Ipc.Left) fail('T6 Tamil e not Left');
  // Reorder Tamil 'ke' (ka + e).
  const cps = [0x0B95, 0x0BC6];
  const ord = reorderSyllable(cps, 0, 2);
  if (ord[0] !== 1 || ord[1] !== 0) fail(`T6 Tamil 'ke' reorder [${ord}]`);
  else ok(`T6 Tamil 'ke' (e is pre-base) → reordered; 'ki' (i is post-base) wouldn't reorder`);
}

// ----- T7: Telugu has NO pre-base reorder ---------------------
{
  // Telugu 'కి' (ka + i) — both stay in logical order.
  const cps = [0x0C15, 0x0C3F];
  const ord = reorderSyllable(cps, 0, 2);
  if (ord[0] !== 0 || ord[1] !== 1) fail(`T7 Telugu 'ki' should be identity, got [${ord}]`);
  else ok(`T7 Telugu 'ki' identity reorder (no pre-base matras)`);
}

// ----- T8: Sinhala reph (Sinhala HAS reph via RA + halant 0x0DCA) -
{
  // Sinhala 'rka' — ra + halant + ka.
  // RA = 0x0DBB, halant = 0x0DCA, ka = 0x0D9A.
  const cps = [0x0DBB, 0x0DCA, 0x0D9A];
  const ord = reorderSyllable(cps, 0, 3);
  // Reph moves to end → [2, 0, 1]
  if (ord[0] !== 2 || ord[1] !== 0 || ord[2] !== 1) {
    fail(`T8 Sinhala reph reorder [${ord}], want [2,0,1]`);
  } else ok(`T8 Sinhala reph (RA at 0x0DBB + halant at 0x0DCA) → reorder to end`);
}

console.log();
console.log(failures === 0 ? 'INDIC-ALL-SCRIPTS PASS' : `INDIC-ALL-SCRIPTS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
