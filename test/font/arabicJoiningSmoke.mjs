// Verifies the Arabic joining-class table and form resolver.

import {
  ArabicJoiningType, ArabicForm,
  getArabicJoiningType, isArabicCodepoint, resolveArabicForms,
} from '../../src/font/scripts/arabicJoining.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: joining-type classification ----------------------------------
{
  // Hand-spot a representative letter from each class.
  const cases = [
    [0x0628, ArabicJoiningType.D, 'beh (Dual)'],
    [0x0645, ArabicJoiningType.D, 'meem (Dual)'],
    [0x0627, ArabicJoiningType.R, 'alef (Right)'],
    [0x062F, ArabicJoiningType.R, 'dal (Right)'],
    [0x0621, ArabicJoiningType.U, 'hamza (Non-joining)'],
    [0x0640, ArabicJoiningType.C, 'tatweel (Causing)'],
    [0x064E, ArabicJoiningType.T, 'fatha (Transparent)'],
    [0x0653, ArabicJoiningType.T, 'maddah above (Transparent)'],
    [0x200D, ArabicJoiningType.C, 'ZWJ (Causing)'],
    [0x200C, ArabicJoiningType.U, 'ZWNJ (Non-joining)'],
  ];
  let allOk = true;
  for (const [cp, want, label] of cases) {
    const got = getArabicJoiningType(cp);
    if (got !== want) { fail(`T1 ${label} U+${cp.toString(16)} got ${got}, want ${want}`); allOk = false; }
  }
  if (allOk) ok(`T1 joining-type classification: ${cases.length} letters across all classes`);
}

// ----- T2: isArabicCodepoint coverage ----------------------------------
{
  if (!isArabicCodepoint(0x0628)) fail('T2 beh not flagged Arabic');
  else if (!isArabicCodepoint(0x06CC)) fail('T2 farsi yeh not flagged Arabic');
  else if (!isArabicCodepoint(0x200D)) fail('T2 ZWJ not flagged Arabic');
  else if (isArabicCodepoint(0x05D0)) fail('T2 Hebrew aleph wrongly flagged Arabic');
  else if (isArabicCodepoint(0x0041)) fail('T2 ASCII A wrongly flagged Arabic');
  else ok(`T2 isArabicCodepoint: Arabic+ZWJ accepted, Hebrew/ASCII rejected`);
}

// ----- T3: single Dual letter → Isol -----------------------------------
{
  const forms = resolveArabicForms([0x0628]);  // beh alone
  if (forms[0] !== ArabicForm.Isol) fail(`T3 single beh got form ${forms[0]}, want Isol`);
  else ok(`T3 single Dual letter → Isol`);
}

// ----- T4: Dual+Dual → Init then Fina ---------------------------------
{
  // beh + teh → بت. In logical order ب then ت.
  // beh's next is teh (Dual → joins-causing) so beh = Init (no prev).
  // teh's prev is beh (Dual → joins-causing) so teh = Fina (no next).
  const forms = resolveArabicForms([0x0628, 0x062A]);
  if (forms[0] !== ArabicForm.Init) fail(`T4 beh in [beh,teh] got ${forms[0]}, want Init`);
  else if (forms[1] !== ArabicForm.Fina) fail(`T4 teh in [beh,teh] got ${forms[1]}, want Fina`);
  else ok(`T4 [beh, teh] → Init, Fina`);
}

// ----- T5: 3 Dual letters → Init, Medi, Fina --------------------------
{
  // beh + meem + teh
  const forms = resolveArabicForms([0x0628, 0x0645, 0x062A]);
  if (forms[0] !== ArabicForm.Init) fail(`T5 [0] beh got ${forms[0]}, want Init`);
  else if (forms[1] !== ArabicForm.Medi) fail(`T5 [1] meem got ${forms[1]}, want Medi`);
  else if (forms[2] !== ArabicForm.Fina) fail(`T5 [2] teh got ${forms[2]}, want Fina`);
  else ok(`T5 [beh, meem, teh] → Init, Medi, Fina`);
}

// ----- T6: Right-joining letter breaks the chain ---------------------
{
  // beh + alef + teh.
  // alef is Right-joining: can join previous (beh) but NOT next (teh).
  // So:
  //   beh.joinsLeft requires next.type ∈ {D, R, C}; alef is R ⇒ true ⇒ beh = Init.
  //   alef.joinsRight: prev beh is Dual → causes; alef can join prev (R) → yes.
  //   alef.joinsLeft: alef can NOT join next (R has no left connector) → false.
  //   ⇒ alef = Fina.
  //   teh.joinsRight: prev alef is R; prevCausesJoin = (prev ∈ {D,L,C}) → false.
  //                   So teh = Isol.
  const forms = resolveArabicForms([0x0628, 0x0627, 0x062A]);
  if (forms[0] !== ArabicForm.Init) fail(`T6 [0] beh got ${forms[0]}, want Init`);
  else if (forms[1] !== ArabicForm.Fina) fail(`T6 [1] alef got ${forms[1]}, want Fina`);
  else if (forms[2] !== ArabicForm.Isol) fail(`T6 [2] teh got ${forms[2]}, want Isol`);
  else ok(`T6 [beh, alef, teh] — Right-joiner breaks chain: Init, Fina, Isol`);
}

// ----- T7: Transparent (fatha) doesn't affect joining --------------
{
  // beh + fatha + teh → بَت.
  // fatha is T; skipped when computing joining for neighbors.
  // beh.joinsLeft looks at next non-T = teh (D, causes) → joinsLeft = true ⇒ Init.
  // teh.joinsRight looks at prev non-T = beh (D, causes) → joinsRight = true ⇒ Fina.
  // fatha inherits the form of beh (last non-T cluster base) = Init.
  const forms = resolveArabicForms([0x0628, 0x064E, 0x062A]);
  if (forms[0] !== ArabicForm.Init) fail(`T7 [0] beh got ${forms[0]}, want Init`);
  else if (forms[1] !== ArabicForm.Init) fail(`T7 [1] fatha got ${forms[1]}, want Init (inherits)`);
  else if (forms[2] !== ArabicForm.Fina) fail(`T7 [2] teh got ${forms[2]}, want Fina`);
  else ok(`T7 transparent fatha doesn't break joining`);
}

// ----- T8: Tatweel (joining causer) keeps chain ----------------------
{
  // beh + tatweel + meem
  // tatweel is C. Symmetric joining-causer.
  // beh.joinsLeft: next = tatweel (C) ⇒ true ⇒ Init.
  // tatweel.joinsRight: prev = beh (D) → true; tatweel.canJoinPrev = true (C) → joinsRight = true.
  // tatweel.joinsLeft: next = meem (D) → true; canJoinNext = true (C) → joinsLeft = true.
  // tatweel = Medi.
  // meem.joinsRight: prev = tatweel (C) → true → Fina.
  const forms = resolveArabicForms([0x0628, 0x0640, 0x0645]);
  if (forms[0] !== ArabicForm.Init) fail(`T8 [0] beh got ${forms[0]}, want Init`);
  else if (forms[1] !== ArabicForm.Medi) fail(`T8 [1] tatweel got ${forms[1]}, want Medi`);
  else if (forms[2] !== ArabicForm.Fina) fail(`T8 [2] meem got ${forms[2]}, want Fina`);
  else ok(`T8 tatweel acts as medial joining causer`);
}

// ----- T9: ZWNJ breaks the chain ------------------------------------
{
  // beh + ZWNJ + meem.
  // ZWNJ is U (non-joining). It doesn't cause; it's a hard break.
  // beh.joinsLeft (nextCausesJoin): next.type ∈ {D, R, C}? ZWNJ = U → false ⇒ beh = Isol.
  // ZWNJ.joinsRight: prev = beh (D) → true; canJoinPrev for U? no (U doesn't have right side) → false.
  //   So we hit the U-branch first: ZWNJ = Isol.
  // meem.joinsRight: prev = ZWNJ (U) → false → meem = Isol.
  const forms = resolveArabicForms([0x0628, 0x200C, 0x0645]);
  if (forms[0] !== ArabicForm.Isol) fail(`T9 [0] beh got ${forms[0]}, want Isol`);
  else if (forms[1] !== ArabicForm.Isol) fail(`T9 [1] ZWNJ got ${forms[1]}, want Isol`);
  else if (forms[2] !== ArabicForm.Isol) fail(`T9 [2] meem got ${forms[2]}, want Isol`);
  else ok(`T9 ZWNJ breaks the joining chain`);
}

// ----- T10: real word "مرحبا" (marhaba — hello) --------------------
{
  // م ر ح ب ا (meem, reh, hah, beh, alef)
  // Logical order: meem reh hah beh alef.
  //
  // meem.next = reh (R: causes? R ∈ {D,R,C} → yes) → meem.joinsLeft = true.
  //   meem.prev = none → joinsRight = false.
  //   ⇒ meem = Init.
  // reh.prev = meem (D) → joinsRight = true (R can join prev).
  //   reh.next = hah (D); but reh.canJoinNext = false (R has no left) → joinsLeft = false.
  //   ⇒ reh = Fina.
  // hah.joinsRight (prevCausesJoin tests prevT ∈ {D, L, C}): reh is R ∉ ⇒ false.
  //   hah.next = beh (D) → joinsLeft = true → hah = Init.
  // beh.prev = hah (D) → joinsRight = true.
  //   beh.next = alef (R) → joinsLeft = true (alef ∈ {D,R,C}) → beh = Medi.
  // alef.prev = beh (D) → joinsRight = true (alef can join prev).
  //   alef.next = none → joinsLeft = false → alef = Fina.
  //
  // ⇒ [Init, Fina, Init, Medi, Fina]
  const forms = resolveArabicForms([0x0645, 0x0631, 0x062D, 0x0628, 0x0627]);
  const want = [ArabicForm.Init, ArabicForm.Fina, ArabicForm.Init, ArabicForm.Medi, ArabicForm.Fina];
  let allOk = true;
  for (let i = 0; i < 5; i++) {
    if (forms[i] !== want[i]) { fail(`T10 [${i}] got ${forms[i]}, want ${want[i]}`); allOk = false; }
  }
  if (allOk) ok(`T10 'مرحبا' → Init Fina Init Medi Fina (lam-alef cluster correct)`);
}

console.log();
console.log(failures === 0 ? 'ARABIC-JOINING PASS' : `ARABIC-JOINING FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
