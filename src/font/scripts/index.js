// font/scripts/ — opt-in script shapers.
//
// Convenience entry: import this to enable EVERY script shaper at
// once. Equivalent to:
//
//   import { registerArabicShaping } from '@kontek/mantle/font/scripts/arabic';
//   import { registerHangulShaping } from '@kontek/mantle/font/scripts/hangul';
//   import { registerIndicShaping }  from '@kontek/mantle/font/scripts/indic';
//   import { registerMathStretchy }  from '@kontek/mantle/font/scripts/math';
//   import { registerThaiShaping }   from '@kontek/mantle/font/scripts/thai';
//   import { registerUseShaping }    from '@kontek/mantle/font/scripts/use';
//
// then individually calling each register*().
//
// Most consumers should import per-script subpaths instead, enabling
// only the shapers they need.
//
//   import { registerAllScriptShapers } from '@kontek/mantle/font/scripts';
//   registerAllScriptShapers();

import { registerArabicShaping } from './arabic.js';
import { registerHangulShaping } from './hangul.js';
import { registerIndicShaping  } from './indic.js';
import { registerMathStretchy  } from './math.js';
import { registerThaiShaping   } from './thai.js';
import { registerUseShaping    } from './use.js';

export {
  registerArabicShaping, registerHangulShaping, registerIndicShaping,
  registerMathStretchy, registerThaiShaping, registerUseShaping,
};

export function registerAllScriptShapers() {
  registerArabicShaping();
  registerHangulShaping();
  registerIndicShaping();
  registerMathStretchy();
  registerThaiShaping();
  registerUseShaping();
}
