// Opt-in registration for Arabic shaping.
//
// Call registerArabicShaping() once at startup to enable positional-form
// substitution (init/medi/fina/isol) + joining-context-aware mark detection
// in textRun. Without it, Arabic codepoints render in their isolated form
// regardless of context.
//
//   import { registerArabicShaping } from '@kontek/mantle/font/scripts/arabic';
//   registerArabicShaping();

import {
  ArabicJoiningType, ArabicForm,
  isArabicCodepoint, resolveArabicForms, getArabicJoiningType,
} from './arabicJoining.js';
import { registerArabicShaping as _register } from '../shaperRegistry.js';

let _registered = false;

/// Wire Arabic shaping into the textRun shaper registry. Idempotent.
export function registerArabicShaping() {
  if (_registered) return;
  _registered = true;
  _register({
    isArabicCodepoint, resolveArabicForms,
    getArabicJoiningType, ArabicJoiningType,
  });
}

// Re-export the shaper primitives for consumers that call them directly
// (e.g. for bidi resolution or asset audits).
export {
  ArabicJoiningType, ArabicForm,
  isArabicCodepoint, resolveArabicForms, getArabicJoiningType,
};
