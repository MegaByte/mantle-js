// font/scripts/math.js — opt-in registration for MATH stretchy
// variants triggered from codepoint alone (top/bottom braces,
// brackets, parens; display-size n-ary operators).
//
//   import { registerMathStretchy } from '@kontek/mantle/font/scripts/math';
//   registerMathStretchy();
//
// Without registration, math codepoints render at their default
// glyph size — readable but not stretched to span their content.

import {
  isCodepointStretchy, isAlwaysStretchy, targetStretchHeight,
} from '../math/mathStretchy.js';
import { registerMathStretchy as _register } from '../shaperRegistry.js';

let _registered = false;

export function registerMathStretchy() {
  if (_registered) return;
  _registered = true;
  _register({ isCodepointStretchy, isAlwaysStretchy, targetStretchHeight });
}

export { isCodepointStretchy, isAlwaysStretchy, targetStretchHeight };
