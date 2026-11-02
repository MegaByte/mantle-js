// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lengthParseSmoke.mjs — parseLength() unit + calc() + var() + min/max/clamp.

import { parseLength, parseLengthOr } from '../../src/svg/length.js';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}
function check(name, got, want, eps) {
  if (Number.isNaN(want)) {
    if (Number.isNaN(got)) ok(`${name} → NaN`);
    else fail(`${name} → ${got} (expected NaN)`);
    return;
  }
  if (approx(got, want, eps)) ok(`${name} → ${got}`);
  else fail(`${name} → ${got} (expected ${want})`);
}

// ---- Bare numbers + units ------------------------------------------
check('"12"', parseLength('12'), 12);
check('"  12.5  "', parseLength('  12.5  '), 12.5);
check('"-3.14"', parseLength('-3.14'), -3.14);
check('"1e2"', parseLength('1e2'), 100);
check('"5px"', parseLength('5px'), 5);
check('"2em" fs=12', parseLength('2em', { fontSize: 12 }), 24);
check('"3rem" rfs=10', parseLength('3rem', { rootFontSize: 10 }), 30);
check('"50%" pw=200', parseLength('50%', { parentWidth: 200 }), 100);
check(
  '"25%" pw=400 axis=y ph=100',
  parseLength('25%', { parentWidth: 400, parentHeight: 100, axis: 'y' }),
  25,
);
check(
  '"100%" axis=d  pw=300 ph=400',
  parseLength('100%', { parentWidth: 300, parentHeight: 400, axis: 'd' }),
  Math.sqrt((90000 + 160000) / 2),
);
check('"1pt"', parseLength('1pt'), 96 / 72);
check('"1in"', parseLength('1in'), 96);
check('"1cm"', parseLength('1cm'), 96 / 2.54);
check('"bogus"', parseLength('bogus'), NaN);

// ---- calc() arithmetic ---------------------------------------------
check('calc(2 + 3)', parseLength('calc(2 + 3)'), 5);
check('calc(10 - 4)', parseLength('calc(10 - 4)'), 6);
check('calc(3 * 4)', parseLength('calc(3 * 4)'), 12);
check('calc(20 / 4)', parseLength('calc(20 / 4)'), 5);
check('precedence  *', parseLength('calc(2 + 3 * 4)'), 14);
check('precedence ()', parseLength('calc((2 + 3) * 4)'), 20);
check('unary minus', parseLength('calc(-5 + 10)'), 5);
check('mixed units', parseLength('calc(100% - 20px)', { parentWidth: 200 }), 180);
check('nested calc', parseLength('calc(100px + calc(10px * 2))'), 120);

// ---- var() ----------------------------------------------------------
{
  const vars = new Map([
    ['--w', '50'],
    ['--mul', '3'],
  ]);
  check('var(--w)', parseLength('var(--w)', { vars }), 50);
  check('var(--w) + 10', parseLength('calc(var(--w) + 10)', { vars }), 60);
  check('var(--missing, 7px)', parseLength('var(--missing, 7px)', { vars }), 7);
  check('var(--missing) no fb', parseLength('var(--missing)', { vars }), NaN);
  check('var(--w) * var(--mul)', parseLength('calc(var(--w) * var(--mul))', { vars }), 150);
  check('var fallback chain', parseLength('var(--missing, calc(2 * 5))', { vars }), 10);
}

// ---- min() / max() / clamp() ---------------------------------------
check('min(3, 5)', parseLength('min(3, 5)'), 3);
check('min(3, 5, 1)', parseLength('min(3, 5, 1)'), 1);
check('max(3, 5)', parseLength('max(3, 5)'), 5);
check('max with units', parseLength('max(50%, 30px)', { parentWidth: 200 }), 100);
check('clamp(0, 50, 100)', parseLength('clamp(0, 50, 100)'), 50);
check('clamp(10, 5, 20)', parseLength('clamp(10, 5, 20)'), 10); // 5 below floor
check('clamp(0, 99, 50)', parseLength('clamp(0, 99, 50)'), 50); // 99 above ceiling
check(
  'clamp w/ vars',
  parseLength('clamp(0, var(--w), 30)', { vars: new Map([['--w', '50']]) }),
  30,
);

// ---- parseLengthOr fallback ---------------------------------------
check('parseLengthOr garbage→7', parseLengthOr('garbage', 7), 7);
check('parseLengthOr 12 → 12', parseLengthOr('12', 7), 12);
check('parseLengthOr undefined→3', parseLengthOr(undefined, 3), 3);

// ---- Tight + spaced forms ------------------------------------------
check('calc tight', parseLength('calc(2+3)'), 5); // no spaces — tolerated
check('calc whitespace', parseLength('  calc( 2 + 3 )  '), 5);

// ---- CSS Values 4: stepped value functions -------------------------
check('round(10, 3)', parseLength('round(10, 3)'), 9);
check('round(11, 3)', parseLength('round(11, 3)'), 12);
check('round(up, 10, 3)', parseLength('round(up, 10, 3)'), 12);
check('round(down, 10, 3)', parseLength('round(down, 10, 3)'), 9);
check('round(to-zero, -10, 3)', parseLength('round(to-zero, -10, 3)'), -9);
check('round(nearest, 7, 5)', parseLength('round(nearest, 7, 5)'), 5);
check('mod(7, 3)', parseLength('mod(7, 3)'), 1);
check('mod(-1, 3)', parseLength('mod(-1, 3)'), 2); // math-mod: result sign of B
check('rem(7, 3)', parseLength('rem(7, 3)'), 1);
check('rem(-7, 3)', parseLength('rem(-7, 3)'), -1); // C-style: result sign of A

// ---- CSS Values 4: trig ---------------------------------------------
check('sin(0)', parseLength('sin(0)'), 0);
check('sin(90deg)', parseLength('sin(90deg)'), 1);
check('cos(0)', parseLength('cos(0)'), 1);
check('cos(180deg)', parseLength('cos(180deg)'), -1);
check('tan(45deg)', parseLength('tan(45deg)'), 1, 1e-9);
check('sin(0.5turn)', parseLength('sin(0.5turn)'), 0, 1e-9);
check('sin(100grad)', parseLength('sin(100grad)'), 1, 1e-9);
check('asin(1) rad', parseLength('asin(1)'), Math.PI / 2);
check('acos(0) rad', parseLength('acos(0)'), Math.PI / 2);
check('atan(1) rad', parseLength('atan(1)'), Math.PI / 4);
check('atan2(1, 1) rad', parseLength('atan2(1, 1)'), Math.PI / 4);

// ---- CSS Values 4: exponential -------------------------------------
check('pow(2, 8)', parseLength('pow(2, 8)'), 256);
check('pow(2, 0.5)', parseLength('pow(2, 0.5)'), Math.SQRT2, 1e-9);
check('sqrt(9)', parseLength('sqrt(9)'), 3);
check('sqrt(2)', parseLength('sqrt(2)'), Math.SQRT2);
check('hypot(3, 4)', parseLength('hypot(3, 4)'), 5);
check('hypot(1, 2, 2)', parseLength('hypot(1, 2, 2)'), 3);
check('log(e)', parseLength('log(2.718281828459045)'), 1, 1e-9);
check('log(100, 10)', parseLength('log(100, 10)'), 2, 1e-9);
check('exp(0)', parseLength('exp(0)'), 1);
check('exp(1)', parseLength('exp(1)'), Math.E, 1e-9);

// ---- CSS Values 4: sign-related ------------------------------------
check('abs(-5)', parseLength('abs(-5)'), 5);
check('abs(5)', parseLength('abs(5)'), 5);
check('sign(-3)', parseLength('sign(-3)'), -1);
check('sign(0)', parseLength('sign(0)'), 0);
check('sign(7)', parseLength('sign(7)'), 1);

// ---- Composability: trig inside calc ------------------------------
check('calc(sin(45deg) * 100)', parseLength('calc(sin(45deg) * 100)'), 100 * Math.SQRT1_2, 1e-9);
check('calc(sqrt(pow(3,2) + pow(4,2)))', parseLength('calc(sqrt(pow(3,2) + pow(4,2)))'), 5);
check('round inside calc', parseLength('calc(round(10.7, 1) + 1)'), 12);
check('clamp w/ pow', parseLength('clamp(0, pow(2, 4), 10)'), 10);
check('abs(calc())', parseLength('abs(calc(-5 + 2))'), 3);

// ---- Real-world SVG examples ---------------------------------------
{
  const ctx = { parentWidth: 800, parentHeight: 600, fontSize: 16 };
  check('responsive width', parseLength('calc(100% - 40px)', ctx), 760);
  check('half + offset', parseLength('calc(50% + 1em)', ctx), 416);
  check('clamp viewport', parseLength('clamp(100, 50%, 600)', ctx), 400);
}

console.log();
console.log(failures === 0 ? 'LENGTH-PARSE PASS' : `LENGTH-PARSE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
