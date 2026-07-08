// cssAtRulesSmoke.mjs — verify @media / @supports parsing.
//
// The parser balances braces, evaluates @media/@supports conditions
// against renderer capabilities, and recurses into the block when the
// condition matches.

import { parseCss } from '../../src/svg/stylesheet.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

function ruleDecls(rules) {
  return rules.map(r => r.decls);
}

// ----- T1: @media screen applies (we render to screen) -------------
{
  const rules = [];
  parseCss('@media screen { rect { fill: red; } } circle { fill: blue; }', rules);
  if (rules.length !== 2) fail(`T1 expected 2 rules, got ${rules.length}`);
  else ok('T1 @media screen applies; both rules parsed');
}

// ----- T2: @media print does NOT apply -----------------------------
{
  const rules = [];
  parseCss('@media print { rect { fill: red; } } circle { fill: blue; }', rules);
  if (rules.length !== 1) fail(`T2 expected 1 rule (only circle), got ${rules.length}`);
  else if (rules[0].decls.fill !== 'blue') fail(`T2 unexpected decl: ${JSON.stringify(rules[0].decls)}`);
  else ok('T2 @media print correctly skipped');
}

// ----- T3: @media all applies --------------------------------------
{
  const rules = [];
  parseCss('@media all { rect { fill: red; } }', rules);
  if (rules.length !== 1) fail(`T3 @media all expected 1 rule, got ${rules.length}`);
  else ok('T3 @media all applies');
}

// ----- T4: @media (feature) safely skips (we can't evaluate) -------
{
  const rules = [];
  parseCss('@media (max-width: 600px) { rect { fill: red; } } circle { fill: blue; }', rules);
  if (rules.length !== 1) fail(`T4 feature query should be conservatively skipped, got ${rules.length}`);
  else ok('T4 @media (max-width) conservatively skipped');
}

// ----- T5: comma list — any branch matches → apply -----------------
{
  const rules = [];
  parseCss('@media print, screen { rect { fill: red; } }', rules);
  if (rules.length !== 1) fail(`T5 expected 1 rule via 'screen' branch, got ${rules.length}`);
  else ok('T5 comma list: screen branch matches → applies');
}

// ----- T6: @supports (known prop) → apply --------------------------
{
  const rules = [];
  parseCss('@supports (fill: red) { rect { fill: red; } }', rules);
  if (rules.length !== 1) fail(`T6 @supports (fill) expected 1 rule, got ${rules.length}`);
  else ok('T6 @supports (fill: red) applies (known prop)');
}

// ----- T7: @supports (unknown prop) → skip -------------------------
{
  const rules = [];
  parseCss('@supports (--unsupported-cssvar: 1) { rect { fill: red; } }', rules);
  if (rules.length !== 0) fail(`T7 unknown @supports prop should skip, got ${rules.length}`);
  else ok('T7 @supports (unknown) safely skipped');
}

// ----- T8: @supports not (...) inverts -----------------------------
{
  const rules = [];
  parseCss('@supports not (fill: x) { rect { fill: red; } }', rules);
  // not (fill: x) → not supportsConditionMatches((fill: x)) → not true → false
  if (rules.length !== 0) fail(`T8 @supports not (fill) should be false, got ${rules.length}`);
  else ok('T8 @supports not (known) correctly false');
}

// ----- T9: @supports A and B ---------------------------------------
{
  const rules = [];
  parseCss('@supports (fill: x) and (stroke: y) { rect { fill: red; } }', rules);
  if (rules.length !== 1) fail(`T9 @supports A and B (both known) expected 1, got ${rules.length}`);
  else ok('T9 @supports (known) and (known) → applies');
}

// ----- T10: @supports A or B (one known) --------------------------
{
  const rules = [];
  parseCss('@supports (unknown-prop: x) or (fill: y) { rect { fill: red; } }', rules);
  if (rules.length !== 1) fail(`T10 @supports A or B (one known) expected 1, got ${rules.length}`);
  else ok('T10 @supports (unknown) or (known) → applies');
}

// ----- T11: @font-face / @keyframes / @import → silently skipped --
{
  const rules = [];
  parseCss(`
    @font-face { font-family: foo; src: url(foo.ttf); }
    @keyframes spin { from {transform:rotate(0)} to {transform:rotate(360deg)} }
    @import url("ext.css");
    rect { fill: red; }
  `, rules);
  if (rules.length !== 1) fail(`T11 non-applicable at-rules should be skipped, got ${rules.length}`);
  else ok('T11 @font-face / @keyframes / @import safely skipped');
}

// ----- T12: nested @media inside @media (rare but legal) -----------
{
  const rules = [];
  parseCss('@media screen { @media all { rect { fill: red; } } }', rules);
  if (rules.length !== 1) fail(`T12 nested @media should pass through, got ${rules.length}`);
  else ok('T12 nested @media screen { @media all { ... } } applies');
}

// ----- T13: rules outside @media still parse -----------------------
{
  const rules = [];
  parseCss(`
    rect { fill: red; }
    @media print { circle { fill: green; } }
    path { stroke: blue; }
  `, rules);
  if (rules.length !== 2) fail(`T13 expected 2 (rect+path, no circle), got ${rules.length}`);
  else ok('T13 rules outside @media unaffected');
}

if (failures > 0) {
  console.error(`\nCSS-AT-RULES FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCSS-AT-RULES PASS');
